# rsdom end-to-end benchmark (app/ suite)

2026-10-17T03:53:11.561Z · Node v22.22.0 · Intel(R) Xeon(R) Processor @ 2.80GHz x4 · 7 samples + 1 warm-up per config, interleaved · ms, medians over VALID samples (min-max when spread > 10%) · git c4e213de00-dirty · addon release 325866fa4f24 · jsdom 30.1.3 · happy-dom 21.0.3 · vitest 5.0.5 · react 19.3.1

Wall = external `vitest run` process time. Phase columns are SUMS over files of Vitest 5's per-file phases. **Use `forks-1` (one worker, no CPU contention) for phase attribution (environment vs tests); use the parallel entries for wall time only.** A sample is valid when vitest exits 0 with 0 failed tests; "valid" shows valid/total and a row with fewer than N-1 valid samples is INVALID. "tests (common)" counts only files that passed in every sample of every DOM of the group; "excl. heavy" also drops *.heavy* files. "critical file" = the long-pole file (env+setup+import+tests), which bounds wall with parallel workers. `!` = some sample ran above the load threshold. With `isolate: false` and maxWorkers > 1 the environment phase is re-reported per file (Vitest Pitfall A): compare wall there.

## forks: forks + isolate (default), 3 workers

common passing files: 11/11 · per-file median tests ratio: jsdom/rsdom 4.16, happy-dom/rsdom 1.48

| DOM | valid | wall | critical file | environment | import | setup | transform | worker | tests | tests (common) | excl. heavy | peak RSS MiB | failed tests / files |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| jsdom | 7/7 ! | 12455 | 11687 (DataTable.heavy.test.tsx) | 9684 | 273 (228-287) | 1568 (1473-1697) | 150 (118-168) | 89 (81-100) | 21884 | 21884 | 11133 | 514 | 0 / 0 |
| happy-dom | 7/7 ! | 10741 (9887-12004) | 9973 (DataTable.heavy.test.tsx) | 4804 (4265-5191) | 251 (220-331) | 1712 (1625-1824) | 120 (98-165) | 87 (74-118) | 15914 (14600-17418) | 15914 (14600-17418) | 6392 (5816-6958) | 1197 | 0 / 0 |
| rsdom | 7/7 ! | 4267 | 2999 (DataTable.heavy.test.tsx) | 619 (590-681) | 320 (278-415) | 1871 | 131 (84-172) | 108 (98-136) | 6223 (6141-7162) | 6223 (6141-7162) | 3509 (3401-4050) | 281 | 0 / 0 |
| rsdom RSDOM_SHARED=0 | 7/7 ! | 4492 (4269-4897) | 3317 (DataTable.heavy.test.tsx) | 542 (469-601) | 412 (360-452) | 1890 (1752-2054) | 237 (211-307) | 128 (114-145) | 6826 (6471-7657) | 6826 (6471-7657) | 3797 (3597-4241) | 345 | 0 / 0 |
| rsdom RSDOM_NO_MEMO=1 | 7/7 ! | 4468 (4182-4730) | 3203 (DataTable.heavy.test.tsx) | 674 (575-699) | 337 (293-451) | 1894 (1758-2070) | 157 (112-228) | 123 (101-133) | 6643 (6070-7012) | 6643 (6070-7012) | 3725 | 282 | 0 / 0 |
| rsdom RSDOM_NO_PREFILTER=1 | 7/7 ! | 4538 (4293-4872) | 3081 (DataTable.heavy.test.tsx) | 625 (585-733) | 366 (310-377) | 1890 (1775-2155) | 150 (124-211) | 111 (98-136) | 6593 (6211-7452) | 6593 (6211-7452) | 3770 (3682-4165) | 282 | 0 / 0 |
| rsdom all off | 7/7 ! | 4584 (4215-5005) | 3329 (DataTable.heavy.test.tsx) | 563 (513-613) | 413 (372-494) | 1880 (1744-1970) | 224 (202-288) | 134 (110-140) | 6698 (6182-7759) | 6698 (6182-7759) | 3743 (3573-4441) | 319 | 0 / 0 |

## forks-1: forks + isolate, maxWorkers=1 (phase attribution: no contention between workers)

common passing files: 11/11 · per-file median tests ratio: jsdom/rsdom 3.83, happy-dom/rsdom 1.53

| DOM | valid | wall | critical file | environment | import | setup | transform | worker | tests | tests (common) | excl. heavy | peak RSS MiB | failed tests / files |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| jsdom | 7/7 ! | 29207 | 9768 (DataTable.heavy.test.tsx) | 7865 | 236 (205-261) | 1345 (1222-1386) | 86 (80-95) | 85 (79-90) | 17381 | 17381 | 8580 (8211-9191) | 482 | 0 / 0 |
| happy-dom | 7/7 ! | 19877 | 8254 (DataTable.heavy.test.tsx) | 3413 (3252-3632) | 200 (190-226) | 1420 (1336-1516) | 79 (70-85) | 83 (72-86) | 12539 | 12539 | 4913 | 1184 | 0 / 0 |
| rsdom | 7/7 ! | 9427 | 2447 (DataTable.heavy.test.tsx) | 508 (471-558) | 234 (224-284) | 1417 | 86 (70-102) | 89 (85-100) | 4977 (4783-5339) | 4977 (4783-5339) | 2724 (2650-2999) | 280 | 0 / 0 |

## threads: threads + isolate, 3 workers

common passing files: 11/11 · per-file median tests ratio: jsdom/rsdom 4.1, happy-dom/rsdom 1.56

| DOM | valid | wall | critical file | environment | import | setup | transform | worker | tests | tests (common) | excl. heavy | peak RSS MiB | failed tests / files |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| jsdom | 7/7 ! | 12066 (11861-13667) | 11381 (DataTable.heavy.test.tsx) | 8871 | 290 (213-356) | 1667 (1467-1748) | 165 (112-238) | 94 (85-104) | 21098 (20238-23578) | 21098 (20238-23578) | 10686 (10169-11547) | 749 | 0 / 0 |
| happy-dom | 7/7 ! | 10714 (10128-11389) | 9886 (DataTable.heavy.test.tsx) | 4156 (3831-4313) | 260 (231-293) | 1604 (1472-1717) | 133 (126-226) | 94 (83-103) | 15416 (14211-16735) | 15416 (14211-16735) | 6039 (5466-6691) | 1295 | 0 / 0 |
| rsdom | 7/7 ! | 4378 (4188-4969) | 3071 (DataTable.heavy.test.tsx) | 653 (633-793) | 317 (281-370) | 1833 (1674-2176) | 148 (114-191) | 109 (91-140) | 6283 (6140-6959) | 6283 (6140-6959) | 3473 (3322-3946) | 491 | 0 / 0 |

## threads-noiso: threads, isolate: false, 3 workers

common passing files: 11/11 · per-file median tests ratio: jsdom/rsdom 3.84, happy-dom/rsdom 1.88

| DOM | valid | wall | critical file | environment | import | setup | transform | worker | tests | tests (common) | excl. heavy | peak RSS MiB | failed tests / files |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| jsdom | 7/7 ! | 11400 (10487-12411) | 10687 (DataTable.heavy.test.tsx) | 8773 (8452-10612) | 146 (110-199) | 470 (378-599) | 125 (100-157) | 26 (20-31) | 18359 (16167-20792) | 18359 (16167-20792) | 8620 (7490-10268) | 705 | 0 / 0 |
| happy-dom | 7/7 ! | 9922 (9335-10446) | 9141 (DataTable.heavy.test.tsx) | 4155 (3599-4741) | 186 (150-209) | 525 (394-594) | 105 (82-123) | 27 (21-32) | 13770 (12805-14604) | 13770 (12805-14604) | 5289 (4818-5765) | 1278 | 0 / 0 |
| rsdom | 7/7 ! | 3648 (3270-3826) | 2880 (DataTable.heavy.test.tsx) | 837 (581-926) | 181 (158-209) | 530 (509-656) | 141 (94-176) | 27 | 5260 (5139-5693) | 5260 (5139-5693) | 2806 (2624-2990) | 456 | 0 / 0 |

## serial: threads, isolate: false, maxWorkers=1

common passing files: 11/11 · per-file median tests ratio: jsdom/rsdom 3.82, happy-dom/rsdom 2.45

| DOM | valid | wall | critical file | environment | import | setup | transform | worker | tests | tests (common) | excl. heavy | peak RSS MiB | failed tests / files |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| jsdom | 7/7 ! | 16260 (15133-18091) | 9708 (DataTable.heavy.test.tsx) | 690 (638-778) | 83 (77-94) | 159 (122-185) | 68 (55-72) | 7 (6-9) | 14468 (13534-16083) | 14468 (13534-16083) | 5662 (5227-6266) | 516 (495-562) | 0 / 0 |
| happy-dom | 7/7 ! | 13188 (12551-15160) | 8173 (DataTable.heavy.test.tsx) | 289 (255-355) | 78 (76-114) | 139 (130-164) | 71 (64-80) | 7 (7-10) | 11679 (11075-13632) | 11679 (11075-13632) | 3988 (3582-5603) | 1520 | 0 / 0 |
| rsdom | 7/7 ! | 5314 (5000-5604) | 2419 (DataTable.heavy.test.tsx) | 49 (46-83) | 90 (79-102) | 152 (148-183) | 73 (63-88) | 9 (7-11) | 4108 (3919-4473) | 4108 (3919-4473) | 1913 (1841-2201) | 407 | 0 / 0 |
| rsdom RSDOM_SHARED=0 | 7/7 ! | 5494 (5139-6007) | 2580 (DataTable.heavy.test.tsx) | 50 (42-66) | 91 (83-100) | 154 (147-182) | 68 (60-87) | 9 (8-11) | 4367 (4119-4683) | 4367 (4119-4683) | 1942 (1773-2054) | 411 | 0 / 0 |
| rsdom RSDOM_NO_MEMO=1 | 7/7 ! | 5275 (4962-5570) | 2449 (DataTable.heavy.test.tsx) | 50 (43-67) | 89 (79-100) | 163 (149-184) | 79 (56-84) | 8 (7-9) | 4099 (3892-4367) | 4099 (3892-4367) | 1860 (1798-2107) | 399 | 0 / 0 |
| rsdom RSDOM_NO_PREFILTER=1 | 7/7 ! | 5430 (4998-5697) | 2568 (DataTable.heavy.test.tsx) | 50 (44-67) | 88 (78-110) | 150 (137-176) | 76 (52-88) | 10 (7-12) | 4311 (3842-4535) | 4311 (3842-4535) | 1953 (1712-2067) | 400 | 0 / 0 |
| rsdom all off | 7/7 ! | 5546 (4902-6023) | 2599 (DataTable.heavy.test.tsx) | 44 (39-52) | 89 (82-105) | 145 (126-175) | 74 (68-81) | 8 (7-11) | 4349 (3919-4973) | 4349 (3919-4973) | 2004 (1900-2324) | 409 | 0 / 0 |

## Best available config per DOM (wall, same worker count)

Candidates: forks, threads, threads-noiso (vmThreads: jsdom / happy-dom only; rsdom cannot run it). Quote "rsdom default vs competitor best" from here.

| DOM | best entry | wall |
|---|---|---:|
| jsdom | threads-noiso | 11400 (10487-12411) |
| happy-dom | threads-noiso | 9922 (9335-10446) |
| rsdom | threads-noiso | 3648 (3270-3826) |

## Per-file median test time (forks-1: forks + isolate, maxWorkers=1 (phase attribution: no contention between workers))

| file | jsdom tests | happy-dom tests | rsdom tests | jsdom env | happy-dom env | rsdom env |
|---|---:|---:|---:|---:|---:|---:|
| src/__tests__/Accordion.test.tsx | 349 | 129 | 68 | 721 | 312 | 44 |
| src/__tests__/AsyncUserList.test.tsx | 453 | 204 | 156 | 697 | 315 | 42 |
| src/__tests__/Counter.test.tsx | 260 | 89 | 69 | 701 | 297 | 47 |
| src/__tests__/Dashboard.test.tsx | 736 | 380 | 208 | 735 | 329 | 42 |
| src/__tests__/DataTable.heavy.test.tsx **(heavy)** | 8864 | 7751 | 2253 | 703 | 307 | 51 |
| src/__tests__/DataTable.test.tsx | 2669 | 1554 | 503 | 722 | 311 | 42 |
| src/__tests__/Modal.test.tsx | 559 | 323 | 260 | 695 | 307 | 45 |
| src/__tests__/SignupForm.test.tsx | 1714 | 1238 | 978 | 697 | 319 | 57 |
| src/__tests__/Tabs.test.tsx | 316 | 113 | 74 | 745 | 288 | 43 |
| src/__tests__/Theme.test.tsx | 253 | 100 | 66 | 710 | 299 | 42 |
| src/__tests__/TodoApp.test.tsx | 1364 | 706 | 349 | 714 | 295 | 47 |

## Native crossings (counters build, forks + isolate, one run)

exit 0; enabled=true; total 605113 native calls, 200.4 ms inside natives (incl. ~20 ns timer overhead per call)

| file | calls | ms in natives |
|---|---:|---:|
| src/__tests__/DataTable.test.tsx | 72888 | 18.95 |
| src/__tests__/SignupForm.test.tsx | 20528 | 20.02 |
| src/__tests__/TodoApp.test.tsx | 32837 | 8.23 |
| src/__tests__/Dashboard.test.tsx | 8948 | 5.18 |
| src/__tests__/Modal.test.tsx | 1703 | 2.34 |
| src/__tests__/Tabs.test.tsx | 1645 | 1.63 |
| src/__tests__/DataTable.heavy.test.tsx | 461586 | 136.33 |
| src/__tests__/AsyncUserList.test.tsx | 1961 | 3.09 |
| src/__tests__/Theme.test.tsx | 594 | 1.71 |
| src/__tests__/Counter.test.tsx | 756 | 1.34 |
| src/__tests__/Accordion.test.tsx | 1667 | 1.6 |

| top natives by time | calls | ms | ns/call |
|---|---:|---:|---:|
| setAttr | 103495 | 54.15 | 523 |
| qsa | 5424 | 26.96 | 4971 |
| createElement | 98621 | 23.85 | 242 |
| textContentSet | 53637 | 22.82 | 425 |
| appendChild | 101351 | 15.36 | 152 |
| csCore | 8966 | 14.23 | 1587 |
| matches | 91043 | 9.27 | 102 |
| hasAttr | 56187 | 6.66 | 118 |
| removeChild | 4074 | 4.12 | 1010 |
| compileSel | 1017 | 3.8 | 3740 |
| labels | 11577 | 3.68 | 318 |
| getAttr | 18482 | 2.2 | 119 |
| styleSet | 218 | 1.91 | 8763 |
| removeAttr | 18894 | 1.69 | 90 |
| setChecked | 19767 | 1.55 | 79 |

