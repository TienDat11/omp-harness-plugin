---
name: harness-loop
description: Vòng tự cải thiện harness — mine lỗi thật từ outcome.json, đề xuất tối đa 3 sửa đổi, chấm trên held-in + held-out, chỉ nhận khi cả hai không giảm. Dùng khi muốn nâng chất lượng quy trình theo thời gian, không dùng giữa task.
---

# Harness loop

Sửa **quy trình**, không sửa sản phẩm. Mỗi vòng: mine → propose → probe → gate → adopt → lesson.

Nguyên tắc: model đóng băng, evaluator đóng băng, chỉ harness đổi. Một sửa đổi chỉ được nhận khi **không làm giảm split nào** và **cải thiện ít nhất một split**.

## Sáu bước

1. Mine — `harness_mine(since_days=14, min_support=2)`. Không có cụm đạt `min_support` → dừng. Không bịa lỗi.
2. Propose — tối đa 3, mỗi đề xuất đủ target/surface/change/expected/risk; ba đề xuất phải khác cơ chế.
3. Probe — chạy `in`+`out` trên harness hiện tại, ghi baseline. Chấm bằng `harness-grader` + `judge_batch` (model `judge`). Deterministic trước; judge chỉ khi cần.
4. Gate — `harness_gate(...)`: nhận khi `d_in >= 0` AND `d_ho >= 0` AND `max(d_in, d_ho) > 0`.
5. Adopt — sau ACCEPT: checkpoint, áp đúng change, ghi lesson, smoke lại.
6. Lesson — một dòng, tối đa 200 ký tự, kèm before/after numbers, trong `.omp/harness/lessons.md`, đọc on-demand. Rejected → `rejected.jsonl`.

## Gate records

- `decisions.jsonl` chỉ gate admission records. `jev-decisions.jsonl` chỉ Jev shadow receipts. Không gộp schema.

## Trigger

- Sau ≥5 task M/L/XL có `outcome.json`, hoặc một repeated failure cluster; chạy đầu session hàng tuần, không bao giờ giữa task. Hai vòng liên tiếp không có accepted edit → dừng.

## Accepted change

- Accepted → tăng `harnessVersion`, cập nhật checksums, ghi accepted baseline. Đổi OMP/model/provider → invalidate comparability, cần baseline mới trước khi propose.

## Deterministic + Jev

- Deterministic checks trước semantic judge. Full held-in AND held-out, hai lần.
- Jev shadow receipts là dữ liệu candidate, không phải lesson. Replay frozen cases qua no-Jev và Jev với expected routes độc lập; record wrong choice/abstain/unavailable/downstream acceptance/fallback riêng. Adopt selector chỉ khi held-in và held-out không regress và ít nhất một split cải thiện.

## Giới hạn

- Filesystem probe không chứng minh spawn. Worker counts từ sibling `<AgentName>.jsonl` (loại `__advisor.jsonl`); routing thật từ `model_change role=subagent:*` và assistant `message.model`. Thiếu artifact/log → `measurement-error`, không phải pass.

## Chống tự lừa

- Probe phải chấm được bằng máy: một lệnh, một quan sát. Không thêm probe ngay sau fix để "chứng minh". `out` split không bao giờ evidence cho propose.
