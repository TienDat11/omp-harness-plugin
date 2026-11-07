"""zero_mem_bridge.py — JSON-lines sidecar for the omp harness.

One request per stdin line, one JSON response per stdout line. Nothing is
printed to stdout except responses; all library chatter is redirected to stderr
so the parent can parse a clean stream.

Commands
    {"cmd":"index","dataset":..,"workdir":..,"units":[{"id":..,"text":..}], "embedding":..}
    {"cmd":"query","dataset":..,"workdir":..,"question":..,"top_k":..,"answer":false,
     "embedding":..,"reader":{"base_url":..,"model":..,"api_key":..}}
    {"cmd":"stats","dataset":..,"workdir":..}

Design notes
  * Zero-Mem's own runtime is vendored under vendor/zero-mem and imported from
    ZERO_MEM_ROOT. The bridge never copies it.
  * Retrieval is zero-LLM: the graph + hierarchy select evidence and the answer
    is returned as evidence text. The reader model (ns24/gpt-6-luna) is only
    called when `answer` is true, because that is the only paid step.
  * NER models without a parser/senter (xx_ent_wiki_sm) need a sentencizer or
    Zero-Mem raises E030. The shim adds one only when the pipeline lacks all
    three sentence-boundary components.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback

ZERO_MEM_ROOT = os.environ.get("ZERO_MEM_ROOT") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor", "zero-mem"
)
if ZERO_MEM_ROOT not in sys.path:
    sys.path.insert(0, ZERO_MEM_ROOT)

DEFAULT_EMBEDDING = os.environ.get("ZERO_MEM_EMBEDDING", "paraphrase-multilingual-MiniLM-L12-v2")
DEFAULT_NER = os.environ.get("ZERO_MEM_NER", "xx_ent_wiki_sm")

_state = {"model": None, "model_name": None, "rag": None, "dataset": None, "workdir": None, "indexed": None}


def _quiet():
    """Zero-Mem prints progress; stdout belongs to the protocol."""
    return contextlib.redirect_stdout(io.StringIO())


def _embedding_model(name: str):
    if _state["model"] is not None and _state["model_name"] == name:
        return _state["model"]
    from sentence_transformers import SentenceTransformer

    device = os.environ.get("ZERO_MEM_DEVICE", "cpu")
    with _quiet():
        model = SentenceTransformer(name, device=device)
    _state["model"] = model
    _state["model_name"] = name
    return model


def _install_sentencizer_shim():
    import spacy

    original = spacy.load

    def load(name, *args, **kwargs):
        nlp = original(name, *args, **kwargs)
        names = set(nlp.pipe_names)
        if not ({"senter", "parser", "sentencizer"} & names):
            nlp.add_pipe("sentencizer")
        return nlp

    spacy.load = load


def _rag(dataset: str, workdir: str, embedding: str, ner: str, reader: dict | None):
    # The reader is part of the identity: an index-only warm caches a rag with
    # no LLM, and reusing it for a paid query fails with `None.infer`.
    key = (dataset, workdir, embedding, ner, (reader or {}).get("model") or "")
    if _state["rag"] is not None and _state["dataset"] == key:
        return _state["rag"]

    _install_sentencizer_shim()
    from src.config import ZeroMemConfig
    from src.ZeroMem import ZeroMem

    llm = None
    if reader:
        base_url = reader.get("base_url")
        api_key = reader.get("api_key")
        if base_url:
            os.environ["OPENAI_BASE_URL"] = base_url
        if api_key:
            os.environ["OPENAI_API_KEY"] = api_key
        from src.utils import ZeroMemReaderClient

        llm = ZeroMemReaderClient(reader.get("model") or "gpt-6-luna")

    cfg = ZeroMemConfig(
        dataset_name=dataset,
        embedding_model=_embedding_model(embedding),
        llm_model=llm,
        spacy_model=ner,
        working_dir=workdir,
        batch_size=int(os.environ.get("ZERO_MEM_BATCH", "32")),
        retrieval_top_k=int(os.environ.get("ZERO_MEM_TOP_K", "5")),
        enable_dual_index=True,
        use_vectorized_retrieval=False,
    )
    with _quiet():
        rag = ZeroMem(cfg)
    _state.update(rag=rag, dataset=key, workdir=workdir)
    return rag


def _corpus(workdir: str, dataset: str) -> str:
    path = os.path.join(workdir, dataset, "units.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def _cache_dir(workdir: str, dataset: str) -> str:
    return os.path.join(workdir, dataset)


def _corpus_fingerprint(path: str) -> str:
    """Stable id-only fingerprint: unit order and text do not affect reuse."""
    import hashlib

    digest = hashlib.sha256()
    for unit in _read_units(path):
        digest.update(str(unit.get("id", "")).encode())
    return digest.hexdigest()


def _marker_path(workdir: str, dataset: str) -> str:
    return os.path.join(_cache_dir(workdir, dataset), "corpus_fingerprint.txt")


def _read_marker(workdir: str, dataset: str) -> str | None:
    path = _marker_path(workdir, dataset)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def _write_marker(workdir: str, dataset: str, fingerprint: str) -> None:
    with open(_marker_path(workdir, dataset), "w", encoding="utf-8") as handle:
        handle.write(fingerprint)


def _index_artifacts(workdir: str, dataset: str) -> bool:
    """True when a complete index exists on disk and can be hydrated without re-embedding."""
    base = _cache_dir(workdir, dataset)
    required = (
        "ZeroMem.graphml",
        "dual_index_metadata.json",
        "ner_results.json",
        "passage_embedding.parquet",
        "entity_embedding.parquet",
        "sentence_embedding.parquet",
        "window_embedding.parquet",
        "episode_embedding.parquet",
    )
    return all(os.path.exists(os.path.join(base, name)) for name in required)


def _install_trigram_cache(rag, base: str) -> None:
    """Re-encoding every trigram costs ~1 min per process start; cache the matrix.

    The cache is keyed by the trigram id list, so any corpus change invalidates
    it by construction and no stale embedding can survive.
    """
    import numpy as np

    ids_path = os.path.join(base, "trigram_ids.json")
    emb_path = os.path.join(base, "trigram_embeddings.npy")
    original = type(rag)._refresh_trigram_embeddings

    def cached(self):
        ids = list(self.hierarchy_trigram_units.keys())
        if os.path.exists(ids_path) and os.path.exists(emb_path):
            try:
                with open(ids_path, "r", encoding="utf-8") as handle:
                    cached_ids = json.load(handle)
                if cached_ids == ids:
                    self.hierarchy_trigram_id_list = ids
                    self.hierarchy_trigram_id_to_embedding_idx = {gid: i for i, gid in enumerate(ids)}
                    self.hierarchy_trigram_embeddings = np.load(emb_path)
                    return
            except Exception:  # noqa: BLE001 - a broken cache must fall back to encoding
                pass
        original(self)
        try:
            with open(ids_path, "w", encoding="utf-8") as handle:
                json.dump(ids, handle)
            np.save(emb_path, self.hierarchy_trigram_embeddings)
        except Exception:  # noqa: BLE001 - cache write is best effort
            pass

    rag._refresh_trigram_embeddings = cached.__get__(rag, type(rag))


def _rebuild_graph_runtime(rag) -> None:
    """`add_nodes()` sets these during index(); a hydrated graph must rebuild them."""
    name_to_vertex: dict[str, int] = {}
    vertex_to_name: dict[int, str] = {}
    for vertex in rag.graph.vs:
        if "name" not in vertex.attributes():
            continue
        name_to_vertex[vertex["name"]] = vertex.index
        vertex_to_name[vertex.index] = vertex["name"]
    rag.node_name_to_vertex_idx = name_to_vertex
    rag.vertex_idx_to_node_name = vertex_to_name
    rag.passage_node_indices = [
        name_to_vertex[hash_id]
        for hash_id in rag.passage_embedding_store.hash_id_to_text
        if hash_id in name_to_vertex
    ]


def _rebuild_entity_sentence_maps(rag, base: str) -> None:
    """`index()` builds these in-memory maps at stage 9; hydration must recreate them."""
    path = os.path.join(base, "ner_results.json")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as handle:
        ner = json.load(handle)
    sentence_to_entities = ner.get("sentence_to_entities") or {}
    entity_store = rag.entity_embedding_store
    sentence_store = rag.sentence_embedding_store
    entity_to_sentence: dict[str, list[str]] = {}
    sentence_to_entity: dict[str, list[str]] = {}
    for sentence, entities in sentence_to_entities.items():
        sentence_hash_id = sentence_store.text_to_hash_id.get(sentence)
        if sentence_hash_id is None:
            continue
        entity_ids = sentence_to_entity.setdefault(sentence_hash_id, [])
        for entity in entities:
            entity_hash_id = entity_store.text_to_hash_id.get(entity)
            if entity_hash_id is None:
                continue
            entity_ids.append(entity_hash_id)
            entity_to_sentence.setdefault(entity_hash_id, []).append(sentence_hash_id)
    rag.entity_hash_id_to_sentence_hash_ids = entity_to_sentence
    rag.sentence_hash_id_to_entity_hash_ids = sentence_to_entity


def _hydrate(rag, workdir: str, dataset: str) -> bool:
    """Load an existing index from disk instead of re-embedding the corpus."""
    base = _cache_dir(workdir, dataset)
    if not _index_artifacts(workdir, dataset):
        return False
    import igraph as ig

    try:
        with _quiet():
            rag.graph = ig.Graph.Read_GraphML(os.path.join(base, "ZeroMem.graphml"))
            hash_id_to_passage = rag.passage_embedding_store.get_hash_id_to_text()
            rag._build_passage_metadata(hash_id_to_passage)
            rag._build_bm25_index(hash_id_to_passage)
            _rebuild_graph_runtime(rag)
            _rebuild_entity_sentence_maps(rag, base)
            _install_trigram_cache(rag, base)
            rag._ensure_hierarchy_runtime()
            rag.prepare_retrieval_runtime(precompute_sparse=False, log=False)
    except Exception:  # noqa: BLE001 - a corrupt cache must fall back to a rebuild
        return False
    return True


def _passage_texts(corpus: list[dict]) -> list[str]:
    return [f"{unit.get('kind', 'note')}: {unit['text']}" for unit in corpus]


def _covers_corpus(rag, corpus: list[dict]) -> bool:
    """Every corpus unit must already be a passage in the loaded index."""
    known = set(rag.passage_embedding_store.hash_id_to_text.keys())
    guard = rag.isolation_guard
    for text in _passage_texts(corpus):
        if guard.passage_hash_id(text) not in known:
            return False
    return True


def _ensure_index(rag, workdir: str, dataset: str, embedding: str, ner: str, reader: dict | None) -> dict:
    """Reuse the on-disk index when it covers the corpus, else rebuild it."""
    path = _corpus(workdir, dataset)
    corpus = _read_units(path)
    if not corpus:
        return {"ok": True, "added": 0, "total": 0, "reused": False}
    fingerprint = _corpus_fingerprint(path)
    # A fresh rag (different reader) starts with nothing loaded, so the ready
    # marker has to carry the rag identity, not just the corpus.
    key = (dataset, workdir, fingerprint, _state["dataset"])
    if _state["indexed"] == key:
        return {"ok": True, "added": 0, "total": len(corpus), "reused": True}
    hydrated = _hydrate(rag, workdir, dataset)
    if hydrated and _read_marker(workdir, dataset) == fingerprint:
        _state["indexed"] = key
        return {"ok": True, "added": 0, "total": len(corpus), "reused": True}
    # No marker yet (first run after an upgrade) or a stale one: the loaded
    # index is only trusted when it actually covers every corpus unit.
    if hydrated and _covers_corpus(rag, corpus):
        _write_marker(workdir, dataset, fingerprint)
        _state["indexed"] = key
        return {"ok": True, "added": 0, "total": len(corpus), "reused": True}
    texts = _passage_texts(corpus)
    with _quiet():
        rag.index(texts)
        rag.prepare_retrieval_runtime(precompute_sparse=False, log=False)
    _write_marker(workdir, dataset, fingerprint)
    _state["indexed"] = key
    return {"ok": True, "added": 0, "total": len(corpus), "reused": False}


def _read_units(path: str) -> list[dict]:
    units: list[dict] = []
    if not os.path.exists(path):
        return units
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                units.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return units


def cmd_index(req: dict) -> dict:
    dataset = req["dataset"]
    workdir = req["workdir"]
    units = req.get("units") or []
    path = _corpus(workdir, dataset)

    known = {unit["id"] for unit in _read_units(path)}
    added = [unit for unit in units if unit.get("id") not in known]
    if added:
        with open(path, "a", encoding="utf-8") as handle:
            for unit in added:
                handle.write(json.dumps(unit, ensure_ascii=False) + "\n")

    corpus = _read_units(path)
    if not corpus:
        return {"ok": True, "added": len(added), "total": 0, "reused": False}
    rag = _rag(dataset, workdir, req.get("embedding") or DEFAULT_EMBEDDING, req.get("ner") or DEFAULT_NER, None)
    result = _ensure_index(
        rag,
        workdir,
        dataset,
        req.get("embedding") or DEFAULT_EMBEDDING,
        req.get("ner") or DEFAULT_NER,
        None,
    )
    return {**result, "added": len(added)}


def cmd_query(req: dict) -> dict:
    dataset = req["dataset"]
    workdir = req["workdir"]
    path = _corpus(workdir, dataset)
    corpus = _read_units(path)
    if not corpus:
        return {"ok": True, "empty": True, "evidence": []}

    rag = _rag(
        dataset,
        workdir,
        req.get("embedding") or DEFAULT_EMBEDDING,
        req.get("ner") or DEFAULT_NER,
        req.get("reader"),
    )
    question = req["question"]
    top_k = int(req.get("top_k") or 5)
    ready = _ensure_index(
        rag,
        workdir,
        dataset,
        req.get("embedding") or DEFAULT_EMBEDDING,
        req.get("ner") or DEFAULT_NER,
        req.get("reader"),
    )
    if not ready.get("ok"):
        return {"ok": False, "error": ready.get("error", "index unavailable"), "evidence": []}
    with _quiet():
        rag.config.retrieval_top_k = top_k
        result = rag.retrieve([{"question": question}], eval_mode="fusion", show_progress=False)[0]

    passages = list(result.get("sorted_passage") or [])[:top_k]
    scores = list(result.get("sorted_passage_scores") or [])[:top_k]
    evidence = []
    for index, text in enumerate(passages):
        evidence.append({"text": text, "score": float(scores[index]) if index < len(scores) else 0.0})

    payload = {"ok": True, "question": question, "evidence": evidence}
    if req.get("answer"):
        with _quiet():
            # The reader returns the whole retrieval record; only `pred_answer`
            # is the synthesized text the caller asked for.
            read = rag.read_one_from_retrieval_result(result, eval_mode="fusion")
        answer = read.get("pred_answer") if isinstance(read, dict) else read
        payload["answer"] = answer if isinstance(answer, str) else json.dumps(answer, default=str)
    return payload


def cmd_stats(req: dict) -> dict:
    path = _corpus(req["workdir"], req["dataset"])
    units = _read_units(path)
    kinds: dict[str, int] = {}
    for unit in units:
        kinds[unit.get("kind", "note")] = kinds.get(unit.get("kind", "note"), 0) + 1
    return {"ok": True, "units": len(units), "kinds": kinds, "corpus": path}


def handle(req: dict) -> dict:
    command = req.get("cmd")
    if command == "index":
        return cmd_index(req)
    if command == "query":
        return cmd_query(req)
    if command == "stats":
        return cmd_stats(req)
    if command == "ping":
        return {"ok": True, "python": sys.version.split()[0], "root": ZERO_MEM_ROOT}
    return {"ok": False, "error": f"unknown cmd {command!r}"}


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            response = handle(json.loads(raw))
        except Exception as error:  # noqa: BLE001 - the parent needs the reason, not a traceback
            response = {
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
                "trace": traceback.format_exc(limit=3),
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
