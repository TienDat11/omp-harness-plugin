import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omp-test-"));
}

export type FakeHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

export interface FakeToolDef {
  name: string;
  execute: (id: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>;
}

export interface FakeCommandDef {
  description?: string;
  handler: (args: unknown, ctx: unknown) => Promise<unknown> | unknown;
}

export interface FakeZodSafeParseResult {
  success: boolean;
  data: unknown;
}

export interface FakeZodBuilder {
  readonly keys: string[];
  object(shape: Record<string, unknown>): FakeZodBuilder;
  string(): FakeZodBuilder;
  number(): FakeZodBuilder;
  boolean(): FakeZodBuilder;
  enum(): FakeZodBuilder;
  array(): FakeZodBuilder;
  optional(): FakeZodBuilder;
  describe(_opts: unknown): FakeZodBuilder;
  min(_n: number): FakeZodBuilder;
  default(_v: unknown): FakeZodBuilder;
  passthrough(): FakeZodBuilder;
  safeParse(value: unknown): FakeZodSafeParseResult;
}

function makeZodBuilder(keys: string[]): FakeZodBuilder {
  const builder: FakeZodBuilder = {
    keys,
    object(shape) {
      return makeZodBuilder([...keys, ...Object.keys(shape)]);
    },
    string() {
      return makeZodBuilder(keys);
    },
    number() {
      return makeZodBuilder(keys);
    },
    boolean() {
      return makeZodBuilder(keys);
    },
    enum() {
      return makeZodBuilder(keys);
    },
    array() {
      return makeZodBuilder(keys);
    },
    optional() {
      return makeZodBuilder(keys);
    },
    describe() {
      return makeZodBuilder(keys);
    },
    min() {
      return makeZodBuilder(keys);
    },
    default() {
      return makeZodBuilder(keys);
    },
    passthrough() {
      return makeZodBuilder(keys);
    },
    safeParse(value) {
      return { success: true, data: value };
    },
  };
  return builder;
}

export type ThrowingSpy = ((...args: unknown[]) => never) & { calls: unknown[][] };

function makeThrowingSpy(name: string): ThrowingSpy {
  const calls: unknown[][] = [];
  function run(...args: unknown[]): never {
    calls.push(args);
    throw new Error(`fakePi: ${name} must not be called by extension code`);
  }
  const spy: ThrowingSpy = Object.assign(run, { calls });
  return spy;
}

export interface FakeNotify {
  (message: string, level?: string): void;
  calls: Array<{ message: string; level?: string }>;
}

function makeNotifier(): FakeNotify {
  const calls: Array<{ message: string; level?: string }> = [];
  function notify(message: string, level?: string): void {
    calls.push({ message, level });
  }
  const fn: FakeNotify = Object.assign(notify, { calls });
  return fn;
}

export interface FakePi {
  readonly zod: FakeZodBuilder;
  readonly handlers: Map<string, FakeHandler[]>;
  readonly tools: Map<string, FakeToolDef>;
  readonly commands: Map<string, FakeCommandDef>;
  readonly sendMessage: ThrowingSpy;
  readonly sendUserMessage: ThrowingSpy;
  readonly appendEntry: ThrowingSpy;
  readonly setModel: ThrowingSpy;
  readonly setThinkingLevel: ThrowingSpy;
  readonly setActiveTools: (tools: string[]) => void;
  readonly getActiveTools: () => string[] | undefined;
  readonly getFlag: () => undefined;
  on(name: string, handler: FakeHandler): void;
  registerTool(def: FakeToolDef): void;
  registerCommand(name: string, def: FakeCommandDef): void;
}

export function fakePi(): FakePi {
  const handlers = new Map<string, FakeHandler[]>();
  const tools = new Map<string, FakeToolDef>();
  const commands = new Map<string, FakeCommandDef>();
  const sendMessage = makeThrowingSpy("sendMessage");
  const sendUserMessage = makeThrowingSpy("sendUserMessage");
  const appendEntry = makeThrowingSpy("appendEntry");
  const setModel = makeThrowingSpy("setModel");
  const setThinkingLevel = makeThrowingSpy("setThinkingLevel");

  /** Active tool set last reported by the host. Extensions read it via getActiveTools and must not set it themselves. */
  const setActiveCalls: unknown[][] = [];
  let activeTools: string[] | undefined;
  const setActiveTools = Object.assign(
    function setActiveTools(tools: string[]): void {
      setActiveCalls.push([tools.slice()]);
      activeTools = tools.slice();
    },
    { calls: setActiveCalls },
  ) as {
    (tools: string[]): void;
    calls: unknown[][];
  };
  function getActiveTools(): string[] | undefined {
    return activeTools;
  }

  function getFlag(): undefined {
    return undefined;
  }
  const zod = makeZodBuilder([]);
  const pi: FakePi = {
    zod,
    handlers,
    tools,
    commands,
    sendMessage,
    sendUserMessage,
    appendEntry,
    setModel,
    setThinkingLevel,
    setActiveTools,
    getActiveTools,
    getFlag,
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
  };
  return pi;
}

export interface FakeCtx {
  readonly cwd: string;
  readonly ui: { notify: FakeNotify };
  readonly sessionManager: { getSessionId(): string };
  getSystemPrompt(): string;
  readonly models: { current(): unknown };
}

export function fakeCtx(cwd: string): FakeCtx {
  const ctx: FakeCtx = {
    cwd,
    ui: { notify: makeNotifier() },
    sessionManager: { getSessionId() { return "test-session"; } },
    getSystemPrompt() { return "<skills>...</skills> block"; },
    models: { current() { return {}; } },
  };
  return ctx;
}

export function collectSpyCalls(spy: { calls: unknown[][] }): unknown[][] {
  return spy.calls;
}
