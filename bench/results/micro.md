# oxidom micro benchmarks

2026-10-17T02:56:33.565Z · Node v22.22.0 · Intel(R) Xeon(R) Processor @ 2.80GHz x4 · 5 processes per case and DOM (interleaved), median of 9 samples of ~100 ms each per process · git c4e213de00 · addon release 325866fa4f24 · jsdom 30.1.3 · happy-dom 21.0.3 · vitest 5.0.5 · OXIDOM_BENCH_SAMPLES=9

| case (DESIGN §13 row) | metric | unit | jsdom | happy-dom | oxidom | oxidom vs best other |
|---|---|---|---:|---:|---:|---|
| mutate (1) | createElement + appendChild + removeChild | ns | 4203 | 2084 (1937-2203) | 727 | 2.9x faster |
| mutate (1) | insertBefore first child + remove() (100 siblings) | ns | 4561 | 2868 | 681 (620-752) | 4.2x faster |
| attr (2) | setAttribute | ns | 561 | 1287 | 108 | 5.2x faster |
| attr (2) | getAttribute (unchanged) | ns | 192 | 26.0 | 11.9 (11.7-13.4) | 2.2x faster |
| attr (2) | hasAttribute (unchanged) | ns | 195 | 24.3 | 26.4 | 1.1x slower |
| attr (2) | setAttribute + getAttribute + hasAttribute, interleaved | ns/triple | 988 | 1370 (1334-1535) | 278 | 3.6x faster |
| deep (3) | bottom-up detached build, 1001 nodes, depth 200, + attach | us | 83638 | 6637 (5865-8657) | 686 (606-759) | 9.7x faster |
| walk (4) | DFS firstChild/nextSibling/parentNode, 4096 nodes, steady | ns/node | 174 | 55.1 (52.1-65.5) | 17.9 | 3.1x faster |
| walk (4) | same walk, interleaved: 1 setAttribute + 1 append/remove per walk | ns/node | 197 (184-217) | 62.9 (55.7-71.0) | 19.6 | 3.2x faster |
| walk (4) | childNodes[i] indexed read of a 100-child list | ns | 201 (199-238) | 143 | 113 | 1.3x faster |
| matches (9) | DTL role selectors x 565 elements, warm | ns/call | 2462 | 133 | 22.9 (22.6-32.0) | 5.8x faster |
| matches (9) | same, interleaved: 1 attribute + 1 child-list mutation per pass | ns/call | 2482 (2318-2622) | 138 | 24.2 | 5.7x faster |
| qsa (10) | querySelectorAll cold (after a mutation), 2709-element table | us/query | 2856 (2552-2965) | 2168 (1859-2255) | 43.1 | 50x faster |
| qsa (10) | querySelectorAll warm (same query, no mutation) | us/query | 183 (167-208) | 0.202 (0.196-0.233) | 2.83 | 14x slower |
| qsa (10) | querySelector #id-less first match, cold | us/query | 36.7 (34.9-40.7) | 2.13 (2.02-3.52) | 0.546 | 3.9x faster |
| gcs (12) | getComputedStyle(el).display, cold after a class mutation | ns | 542678 (489402-617284) | 1094299 (1047125-1177588) | 1221 | 444x faster |
| gcs (12) | getComputedStyle(el).visibility, warm (no mutation) | ns | 2585 | 336 (321-386) | 61.4 | 5.5x faster |
| gcs (12) | 4 properties (display, color, margin-left, font-weight), cold after a class mutation | ns | 821927 | 1081559 (1029229-1172826) | 2750 | 299x faster |
| gcs (12) | getPropertyValue("color"), cold after a class mutation | ns | 744459 | 1227811 (1171664-1347559) | 1881 | 396x faster |
| gcs (12) | display, cold after a class mutation, + 800-rule class-keyed sheet | ns | 618452 | 2042398 (1887596-2329370) | 1251 | 494x faster |
| gcs (12) | getPropertyValue("color"), cold after a class mutation, + 800-rule sheet | ns | 1381427 (1311214-1452789) | 1993739 | 2006 | 689x faster |
| focus (13) | focus() alternating between two inputs (blur/focusout/focus/focusin) | ns | 168879 | 9883 | 1542 (1396-1558) | 6.4x faster |
| event (14) | new MouseEvent + dispatch, 20 levels, React-like listeners | ns | 17985 | 15999 (15532-29094) | 3680 (3416-3814) | 4.3x faster |
| parse (15) | innerHTML set, 300-row table | us | 46587 | 51366 (49051-56109) | 3248 (3193-4230) | 14x faster |
| serialize (16) | outerHTML get, 300-row table, after a text mutation | us | 1623 (1500-2036) | 4312 (3190-6071) | 181 (174-194) | 9.0x faster |
| serialize (16) | textContent get, same table, after a text mutation | us | 340 (309-405) | 679 (639-730) | 26.1 | 13x faster |
| mo (18) | observe + disconnect, 4096-node subtree (DTL waitFor options) | ns/pair | 2397 (2286-2769) | 827132 (804405-939980) | 382 (310-564) | 6.3x faster |
| mo (18) | appendChild + remove under an active subtree observer (records queued) | ns/pair | 9915 (9250-10884) | 6839 (6233-8115) | 1479 (1327-1605) | 4.6x faster |
| mo (18) | burst of 100 mutations -> one callback delivery (await microtask) | us/burst | 476 (460-519) | 323 (305-352) | 60.8 (53.4-64.3) | 5.3x faster |
| mem (19) | RSS per retained <div class> (100k, wrapper alive) | bytes | 2011 | 6569 | 347 | 5.8x less |
| mem (19) | V8 heap + external per retained <div class> | bytes | 2123 | 6404 | 97.7 | 22x less |
| mem (19) | V8 heap only per retained <div class> (not comparable: oxidom data lives outside V8) | bytes-nc | 2123 | 6404 | 97.7 | not comparable |
| mem (19) | churn: RSS growth per created-and-discarded node (2000 x innerHTML of 339 nodes, after gc) | bytes | 2.15 (-0.236-4.56) | 4.09 (0.665-4.77) | 173 | 80x more |
| env (17) | environment setup (import + window on globalThis), fresh process, in-process timing | ms | 744 (692-779) | 323 (307-381) | 36.7 (34.1-44.6) | 8.8x faster |
| env (17) |   of which: environment module import | ms-nc | 0.005 (0.004-0.006) | 0.005 (0.004-0.007) | 0.892 (0.769-1.43) | not comparable |
| env (17) |   of which: setup() | ms-nc | 744 (692-779) | 323 (307-381) | 35.9 (33.3-43.2) | not comparable |
| env (17) | environment teardown | ms | 0.541 (0.473-0.858) | 2.67 (1.34-2.88) | 1.20 (1.10-4.93) | 2.2x slower |
| env-vitest (17) | Vitest environment phase per file (forks, isolate, maxWorkers=1) | ms | 709 | 318 (288-345) | 45.3 (42.2-58.4) | 7.0x faster |
| env-vitest (17) | vitest run wall, 6 trivial files (forks, maxWorkers=1) | ms | 5805 (5650-6286) | 3527 | 1812 (1695-1992) | 1.9x faster |
| react (react) | createRoot + render 1000-row table (flushSync) | ms | 204 (173-238) | 284 | 66.5 (64.4-107) | 3.1x faster |
| react (react) | update: re-render with a new selected row | ms | 63.2 (54.2-68.8) | 67.4 (62.1-82.3) | 52.7 (49.7-59.1) | ~parity (ranges overlap) |
| testing-library (dtl) | getAllByRole("row") on a 1000-row table | ms | 272 (253-303) | 13.1 (12.5-15.4) | 2.29 (2.20-3.16) | 5.7x faster |
| testing-library (dtl) | getByRole("button", {name}) on the same table (accessible names) | ms | 214 | 21.0 (20.5-25.8) | 6.35 (5.87-7.09) | 3.3x faster |

Value = median over processes of each process's median; (a-b) = min-max across processes when wider than 10%; `!` = at least one process ran above the load threshold (re-run on an idle machine). A ratio is printed only when the process ranges of oxidom and the best other DOM do not overlap. oxidom never reclaims nodes inside an env: mutate / deep / parse rows exclude the freeing work GC-based DOMs pay; see the mem `churn` row for the memory side of that trade-off.
