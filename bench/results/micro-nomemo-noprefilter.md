# oxidom micro benchmarks (nomemo-noprefilter)

2026-10-17T03:34:59.928Z · Node v22.22.0 · Intel(R) Xeon(R) Processor @ 2.80GHz x4 · 5 processes per case and DOM (interleaved), median of 9 samples of ~100 ms each per process · git c4e213de00-dirty · addon release 325866fa4f24 · jsdom 30.1.3 · happy-dom 21.0.3 · vitest 5.0.5 · OXIDOM_NO_PREFILTER=1 OXIDOM_BENCH_SAMPLES=9 OXIDOM_NO_MEMO=1

| case (DESIGN §13 row) | metric | unit | jsdom | happy-dom | oxidom | oxidom vs best other |
|---|---|---|---:|---:|---:|---|
| mutate (1) | createElement + appendChild + removeChild | ns | 4114 (3907-4630) | 2004 | 716 (686-758) | 2.8x faster |
| mutate (1) | insertBefore first child + remove() (100 siblings) | ns | 4406 | 2857 (2824-3774) | 721 (583-867) | 4.0x faster |
| attr (2) | setAttribute | ns | 552 | 1335 (1172-1450) | 107 (101-147) | 5.2x faster |
| attr (2) | getAttribute (unchanged) | ns | 192 | 27.3 (25.1-30.4) | 59.4 | 2.2x slower |
| attr (2) | hasAttribute (unchanged) | ns | 191 (184-204) | 24.9 (23.8-30.4) | 42.7 (41.9-46.5) | 1.7x slower |
| attr (2) | setAttribute + getAttribute + hasAttribute, interleaved | ns/triple | 992 | 1387 (1289-1586) | 233 | 4.3x faster |
| deep (3) | bottom-up detached build, 1001 nodes, depth 200, + attach | us | 86620 (83300-94029) | 6868 (6476-8688) | 654 (600-828) | 11x faster |
| walk (4) | DFS firstChild/nextSibling/parentNode, 4096 nodes, steady | ns/node | 177 (164-194) | 56.4 (51.6-76.3) | 18.2 | 3.1x faster |
| walk (4) | same walk, interleaved: 1 setAttribute + 1 append/remove per walk | ns/node | 200 (186-219) | 67.1 (54.1-73.3) | 19.2 | 3.5x faster |
| walk (4) | childNodes[i] indexed read of a 100-child list | ns | 206 | 142 (140-175) | 111 | 1.3x faster |
| matches (9) | DTL role selectors x 565 elements, warm | ns/call | 2442 (2401-2743) | 179 (137-184) | 74.4 (68.9-84.8) | 2.4x faster |
| matches (9) | same, interleaved: 1 attribute + 1 child-list mutation per pass | ns/call | 2506 | 171 (147-198) | 71.4 | 2.4x faster |
| qsa (10) | querySelectorAll cold (after a mutation), 2709-element table | us/query | 3954 (2714-4824) | 2774 (2048-3999) | 41.8 | 66x faster |
| qsa (10) | querySelectorAll warm (same query, no mutation) | us/query | 189 (177-203) | 0.209 | 34.2 | 164x slower |
| qsa (10) | querySelector #id-less first match, cold | us/query | 36.8 (33.6-45.5) | 3.00 (2.10-3.97) | 0.352 (0.341-0.471) | 8.5x faster |
| gcs (12) | getComputedStyle(el).display, cold after a class mutation | ns | 517585 (497153-633011) | 1043923 | 1151 (1125-1281) | 450x faster |
| gcs (12) | getComputedStyle(el).visibility, warm (no mutation) | ns | 2587 (2512-2917) | 330 (323-361) | 933 | 2.8x slower |
| gcs (12) | 4 properties (display, color, margin-left, font-weight), cold after a class mutation | ns | 842722 (799979-954655) | 1097601 | 2691 | 313x faster |
| gcs (12) | getPropertyValue("color"), cold after a class mutation | ns | 745132 (726047-857191) | 1188567 | 1808 (1705-2125) | 412x faster |
| gcs (12) | display, cold after a class mutation, + 800-rule class-keyed sheet | ns | 630355 (590845-688092) | 2097635 (1875559-2295735) | 1210 | 521x faster |
| gcs (12) | getPropertyValue("color"), cold after a class mutation, + 800-rule sheet | ns | 1463430 (1377304-1562417) | 1954793 (1940454-2229298) | 1921 | 762x faster |
| focus (13) | focus() alternating between two inputs (blur/focusout/focus/focusin) | ns | 161780 | 9840 | 2938 | 3.3x faster |
| event (14) | new MouseEvent + dispatch, 20 levels, React-like listeners | ns | 17203 | 16118 (14883-21883) | 3612 | 4.5x faster |
| parse (15) | innerHTML set, 300-row table | us | 49919 (47314-60033) | 55629 (53354-60046) | 3311 (3235-4862) | 15x faster |
| serialize (16) | outerHTML get, 300-row table, after a text mutation | us | 1629 (1458-1856) | 2728 (2278-5788) | 165 (161-180) | 9.9x faster |
| serialize (16) | textContent get, same table, after a text mutation | us | 307 (295-363) | 643 (623-701) | 25.9 | 12x faster |
| mo (18) | observe + disconnect, 4096-node subtree (DTL waitFor options) | ns/pair | 2595 (2206-2757) | 829528 (764646-968219) | 379 (328-396) | 6.8x faster |
| mo (18) | appendChild + remove under an active subtree observer (records queued) | ns/pair | 11427 (8945-12357) | 6599 (6471-7645) | 1348 (1215-1449) | 4.9x faster |
| mo (18) | burst of 100 mutations -> one callback delivery (await microtask) | us/burst | 451 (444-515) | 318 (195-343) | 59.3 (52.6-62.9) | 5.4x faster |
| mem (19) | RSS per retained <div class> (100k, wrapper alive) | bytes | 1989 | 6627 | 345 | 5.8x less |
| mem (19) | V8 heap + external per retained <div class> | bytes | 2123 | 6404 | 97.7 | 22x less |
| mem (19) | V8 heap only per retained <div class> (not comparable: oxidom data lives outside V8) | bytes-nc | 2123 | 6404 | 97.7 | not comparable |
| mem (19) | churn: RSS growth per created-and-discarded node (2000 x innerHTML of 339 nodes, after gc) | bytes | 3.11 (-0.779-4.57) | 1.09 (0.616-4.85) | 173 | 159x more |
| env (17) | environment setup (import + window on globalThis), fresh process, in-process timing | ms | 779 (698-861) | 331 (289-394) | 40.8 (34.9-53.3) | 8.1x faster |
| env (17) |   of which: environment module import | ms-nc | 0.005 (0.004-0.012) | 0.006 (0.004-0.011) | 1.10 (0.816-1.76) | not comparable |
| env (17) |   of which: setup() | ms-nc | 779 (698-861) | 331 (289-394) | 39.9 (34.1-51.9) | not comparable |
| env (17) | environment teardown | ms | 0.579 (0.494-0.706) | 2.76 (1.46-3.15) | 1.20 (1.04-4.01) | 2.1x slower |
| env-vitest (17) | Vitest environment phase per file (forks, isolate, maxWorkers=1) | ms | 735 (689-766) | 315 (296-351) | 46.0 (41.3-52.0) | 6.9x faster |
| env-vitest (17) | vitest run wall, 6 trivial files (forks, maxWorkers=1) | ms | 5930 (5684-6358) | 3432 (3232-3788) | 1844 (1672-1938) | 1.9x faster |
| react (react) | createRoot + render 1000-row table (flushSync) | ms | 174 (159-205) | 283 (264-293) | 67.2 (63.9-75.2) | 2.6x faster |
| react (react) | update: re-render with a new selected row | ms | 56.8 (49.8-59.1) | 60.3 (56.3-78.2) | 49.3 (44.5-62.3) | ~parity (ranges overlap) |
| testing-library (dtl) | getAllByRole("row") on a 1000-row table | ms | 263 | 14.7 (12.5-16.7) | 10.0 | 1.5x faster |
| testing-library (dtl) | getByRole("button", {name}) on the same table (accessible names) | ms | 220 (213-246) | 22.5 (19.0-24.4) | 10.4 | 2.2x faster |

Value = median over processes of each process's median; (a-b) = min-max across processes when wider than 10%; `!` = at least one process ran above the load threshold (re-run on an idle machine). A ratio is printed only when the process ranges of oxidom and the best other DOM do not overlap. oxidom never reclaims nodes inside an env: mutate / deep / parse rows exclude the freeing work GC-based DOMs pay; see the mem `churn` row for the memory side of that trade-off.
