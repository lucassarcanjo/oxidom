# API surface census: jsdom vs happy-dom vs oxidom

Generated 2026-10-19T16:53:24.827Z by `conformance/api-surface` (node v22.22.0; jsdom 30.1.3, happy-dom 21.0.3, vitest 5.0.5, oxidom 0.1.0).
Each DOM was installed on `globalThis` exactly as the Vitest 5 environment does it, in its own process; presence is read from the global object the tests see.

## Totals (WebIDL from jsdom living/, 227 files)

- IDL: 209 interfaces exposed on Window, 1877 members (attributes, operations, constants, statics, iterator methods; overloads deduplicated; indexed/named getters excluded).
- jsdom runtime (Vitest global): 209 interfaces, 1877 members present. 0 IDL items not visible on the jsdom Vitest global (see surface.json `jsdomIdlGaps`).

| | interfaces | % | members present (R+C+O) | % | on the right interface (R) | % | instance-only (O) | on a subclass only (S, not counted) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| jsdom | 209/209 | 100.0% | 1877/1877 | 100.0% | 1877/1877 | 100.0% | 0 | 0 |
| happy-dom | 178/209 | 85.2% | 1344/1877 | 71.6% | 941/1877 | 50.1% | 129 | 38 |
| oxidom | 149/209 | 71.3% | 1167/1877 | 62.2% | 1166/1877 | 62.1% | 0 | 0 |

Excluding the HTML spec's obsolete features (6 interfaces such as HTMLMarqueeElement, and 98 obsolete members such as `align`/`bgColor`): jsdom 203 interfaces / 1733 members; happy-dom 177 (87.2%) / 1341 (77.4%); oxidom 143 (70.4%) / 1140 (65.8%).

Mixins are counted on every interface that includes them, so 339 of the 1877 members are `on*` event-handler attributes (GlobalEventHandlers alone is included by HTMLElement, SVGElement and Document). Excluding `on*` handlers: jsdom 1538 members; happy-dom 1092 (71.0%); oxidom 858 (55.8%).

Status legend: R = own property of the right object (interface prototype; constructor for statics/constants; the namespace object; the instance for [LegacyUnforgeable]); C = inherited from another object in the chain; O = own property of an instance only (class field); S = only on a subclass prototype; M = missing; I = interface missing.

Interfaces whose global is Node's own class rather than the DOM's (counted as present): jsdom: AbortController, AbortSignal, Headers, TextDecoder, TextEncoder; happy-dom: TextDecoder, TextEncoder; oxidom: AbortController, AbortSignal, Blob, Crypto, DOMException, File, Headers, MessageEvent, Performance, TextDecoder, TextEncoder, WebSocket.

## Per area (members counted only where jsdom has them; a member of a missing interface counts as missing)

| area | jsdom ifaces | happy-dom ifaces | oxidom ifaces | jsdom members | happy-dom members | % | oxidom members | % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CSSOM | 25 | 15 | 2 | 98 | 50 | 51.0% | 10 | 10.2% |
| Custom elements & Shadow DOM | 4 | 4 | 2 | 13 | 13 | 100.0% | 1 | 7.7% |
| DOM core | 23 | 18 | 22 | 436 | 313 | 71.8% | 369 | 84.6% |
| Encoding | 2 | 2 | 2 | 7 | 7 | 100.0% | 7 | 100.0% |
| Events | 27 | 24 | 19 | 150 | 111 | 74.0% | 127 | 84.7% |
| File API | 4 | 4 | 3 | 27 | 23 | 85.2% | 10 | 37.0% |
| Forms & constraint validation | 21 | 19 | 20 | 259 | 202 | 78.0% | 199 | 76.8% |
| Geometry | 2 | 2 | 0 | 15 | 15 | 100.0% | 0 | 0.0% |
| HTML elements | 55 | 50 | 55 | 473 | 255 | 53.9% | 215 | 45.5% |
| Misc (performance, crypto) | 2 | 0 | 2 | 5 | 0 | 0.0% | 5 | 100.0% |
| Mutation observers | 2 | 2 | 2 | 12 | 12 | 100.0% | 12 | 100.0% |
| Networking (XHR, fetch, WebSocket) | 5 | 5 | 2 | 58 | 51 | 87.9% | 27 | 46.6% |
| Parsing & serialization | 2 | 2 | 1 | 2 | 2 | 100.0% | 1 | 50.0% |
| SVG | 17 | 17 | 10 | 164 | 144 | 87.8% | 97 | 59.1% |
| Storage | 1 | 1 | 1 | 6 | 6 | 100.0% | 6 | 100.0% |
| Traversal, Range & Selection | 7 | 5 | 2 | 89 | 81 | 91.0% | 40 | 44.9% |
| Window, navigation & history | 10 | 8 | 4 | 63 | 59 | 93.7% | 41 | 65.1% |

### Missing interfaces per area

- **CSSOM**: happy-dom lacks CSSCounterStyleRule, CSSImportRule, CSSLayerBlockRule, CSSLayerStatementRule, CSSNamespaceRule, CSSNestedDeclarations, CSSPageRule, CSSRuleList, StyleSheet, StyleSheetList; oxidom lacks CSSConditionRule, CSSContainerRule, CSSCounterStyleRule, CSSFontFaceRule, CSSGroupingRule, CSSImportRule, CSSKeyframeRule, CSSKeyframesRule, CSSLayerBlockRule, CSSLayerStatementRule, CSSMediaRule, CSSNamespaceRule, CSSNestedDeclarations, CSSPageRule, CSSRule, CSSRuleList, CSSScopeRule, CSSStyleRule, CSSStyleSheet, CSSSupportsRule, MediaList, StyleSheet, StyleSheetList.
- **Custom elements & Shadow DOM**: happy-dom lacks none; oxidom lacks CustomElementRegistry, ShadowRoot.
- **DOM core**: happy-dom lacks CDATASection, DOMImplementation, DOMStringMap, DOMTokenList, QuotaExceededError; oxidom lacks QuotaExceededError.
- **Events**: happy-dom lacks DeviceMotionEventAcceleration, DeviceMotionEventRotationRate, PromiseRejectionEvent; oxidom lacks BeforeUnloadEvent, BlobEvent, CloseEvent, DeviceMotionEvent, DeviceMotionEventAcceleration, DeviceMotionEventRotationRate, DeviceOrientationEvent, PromiseRejectionEvent.
- **File API**: happy-dom lacks none; oxidom lacks FileReader.
- **Forms & constraint validation**: happy-dom lacks ElementInternals, HTMLFormControlsCollection; oxidom lacks ElementInternals.
- **Geometry**: happy-dom lacks none; oxidom lacks DOMRect, DOMRectReadOnly.
- **HTML elements**: happy-dom lacks HTMLDirectoryElement, HTMLFontElement, HTMLFrameElement, HTMLFrameSetElement, HTMLMarqueeElement; oxidom lacks none.
- **Misc (performance, crypto)**: happy-dom lacks Crypto, Performance; oxidom lacks none.
- **Networking (XHR, fetch, WebSocket)**: happy-dom lacks none; oxidom lacks XMLHttpRequest, XMLHttpRequestEventTarget, XMLHttpRequestUpload.
- **Parsing & serialization**: happy-dom lacks none; oxidom lacks XMLSerializer.
- **SVG**: happy-dom lacks none; oxidom lacks SVGAnimatedPreserveAspectRatio, SVGAnimatedRect, SVGAnimatedString, SVGNumber, SVGPreserveAspectRatio, SVGRect, SVGStringList.
- **Traversal, Range & Selection**: happy-dom lacks AbstractRange, StaticRange; oxidom lacks AbstractRange, NodeFilter, NodeIterator, StaticRange, TreeWalker.
- **Window, navigation & history**: happy-dom lacks BarProp, External; oxidom lacks BarProp, External, MimeType, MimeTypeArray, Plugin, PluginArray.

### Interfaces missing from the global although instances exist (informational, not counted)

- happy-dom: Crypto (via crypto; 2/2 instance members reachable), DOMImplementation (via document.implementation; 3/4 instance members reachable), DOMStringMap (via dataset; 0/0 instance members reachable), DOMTokenList (via classList; 15/15 instance members reachable), HTMLFormControlsCollection (via form.elements; 1/1 instance members reachable), Performance (via performance; 3/3 instance members reachable)
- oxidom: none

## Window members (jsdom has no Window.webidl; derived from jsdom's real window object)

180 members, 10 of which plain Node also has (timers, atob, fetch, performance, ...).

| | present | % | present, excluding Node-provided | % |
|---|---:|---:|---:|---:|
| jsdom (Vitest global) | 180/180 | 100.0% | 170/170 | 100.0% |
| happy-dom | 151/180 | 83.9% | 141/170 | 82.9% |
| oxidom | 165/180 | 91.7% | 155/170 | 91.2% |

- jsdom missing: none
- happy-dom missing: alert, captureEvents, confirm, event, external, frameElement, length, locationbar, menubar, moveBy, moveTo, oncopy, oncut, onpaste, ontouchcancel, ontouchend, ontouchmove, ontouchstart, origin, personalbar, print, prompt, releaseEvents, scrollbars, status, statusbar, stop, toolbar, webkitURL
- oxidom missing: captureEvents, customElements, external, length, locationbar, menubar, name, personalbar, postMessage, releaseEvents, scrollbars, status, statusbar, toolbar, webkitURL

## jsdom interfaces outside living/*.webidl (members from jsdom's runtime prototypes)

| interface | members | jsdom | happy-dom | oxidom |
|---|---:|---|---|---|
| URL | 16 | 16/16 | 16/16 | 16/16 (Node's) |
| URLSearchParams | 14 | 14/14 (Node's) | 14/14 | 14/14 (Node's) |
| CSSStyleProperties | 1640 | 1640/1640 | (no global) 590/1640 | 1640/1640 |
| HTMLDocument | 166 | 166/166 | 144/166 | 140/166 |
| XPathException | 2 | 2/2 | (no global) 0/2 | (no global) 0/2 |
| XPathExpression | 1 | 1/1 | (no global) 0/1 | (no global) 0/1 |
| XPathResult | 19 | 19/19 | (no global) 0/19 | (no global) 0/19 |
| XPathEvaluator | 3 | 3/3 | (no global) 0/3 | (no global) 0/3 |

CSSStyleProperties, camelCase unprefixed accessors only: 753 in jsdom; happy-dom 590, oxidom 753.

CSSStyleProperties members are CSS property accessors (camelCase, dashed and webkit-prefixed); they are checked on each DOM's `document.body.style` instance chain.

## Most important gaps for app testing (curated tiers, see importance.mjs)

### happy-dom: 25 of 385 curated items missing

- **P0** (2): `Event.isTrusted`, `KeyboardEvent.charCode`
- **P1** (11): `Element.ariaLabel`, `HTMLElement.offsetParent`, `HTMLElement.attachInternals`, `HTMLElement.draggable`, `PromiseRejectionEvent`*, `DOMTokenList`*, `StaticRange`*, `Performance`*, `window.alert`, `window.confirm`, `window.event`
- **P2** (12): `CDATASection`*, `DOMImplementation`*, `CSSRuleList`*, `StyleSheetList`*, `BarProp`*, `External`*, `Crypto`*, `ElementInternals`*, `HTMLFormControlsCollection`*, `QuotaExceededError`*, `Document.evaluate`, `Document.lastModified`

### oxidom: 71 of 385 curated items missing

- **P1** (41): `Document.createEvent`, `Document.createTreeWalker`, `Document.styleSheets`, `Range.deleteContents`, `Range.insertNode`, `HTMLInputElement.valueAsDate`, `HTMLInputElement.stepUp`, `Element.attachShadow`, `Element.role`, `Element.ariaLabel`, `HTMLElement.attachInternals`, `HTMLSlotElement.assignedNodes`, `BeforeUnloadEvent`*, `PromiseRejectionEvent`*, `CloseEvent`*, `XMLSerializer`*, `ShadowRoot`*, `CustomElementRegistry`*, `DOMRect`*, `DOMRectReadOnly`*, `FileReader`*, `XMLHttpRequest`*, `StaticRange`*, `CustomElementRegistry.define`*, `CustomElementRegistry.get`*, `CustomElementRegistry.whenDefined`*, `CustomElementRegistry.upgrade`*, `XMLHttpRequest.open`*, `XMLHttpRequest.send`*, `XMLHttpRequest.setRequestHeader`*, `XMLHttpRequest.abort`*, `XMLHttpRequest.responseText`*, `XMLHttpRequest.status`*, `XMLHttpRequest.onload`*, `FileReader.readAsText`*, `FileReader.readAsDataURL`*, `FileReader.readAsArrayBuffer`*, `FileReader.result`*, `window.customElements`, `window.postMessage`, `window.name`
- **P2** (30): `TreeWalker`*, `NodeIterator`*, `NodeFilter`*, `CSSStyleSheet`*, `CSSRule`*, `CSSRuleList`*, `StyleSheetList`*, `MediaList`*, `SVGRect`*, `DeviceOrientationEvent`*, `DeviceMotionEvent`*, `BarProp`*, `External`*, `Plugin`*, `PluginArray`*, `MimeType`*, `MimeTypeArray`*, `ElementInternals`*, `XMLHttpRequestUpload`*, `BlobEvent`*, `QuotaExceededError`*, `CSSStyleSheet.insertRule`*, `CSSStyleSheet.deleteRule`*, `CSSStyleSheet.cssRules`*, `CSSStyleSheet.replaceSync`*, `CSSStyleSheet.replace`*, `Document.createNodeIterator`, `Document.evaluate`, `Document.currentScript`, `Document.lastModified`

### jsdom (vitest global): 0 of 385 curated items missing


`*` = the whole interface is missing from the global.

### Curated items jsdom itself lacks (excluded from the counts above)

| key | tier | jsdom | happy-dom | oxidom |
|---|---|---|---|---|
| `Document.elementFromPoint` | P1 | M | C | M |
| `Range.getBoundingClientRect` | P1 | M | C | R |
| `HTMLInputElement.showPicker` | P1 | M | M | M |
| `Element.scrollIntoView` | P1 | M | R | M |
| `Element.scrollTo` | P1 | M | R | M |
| `HTMLElement.contentEditable` | P1 | M | R | R |
| `HTMLElement.isContentEditable` | P1 | M | R | R |
| `HTMLElement.inert` | P1 | M | R | M |
| `HTMLElement.innerText` | P1 | M | R | R |
| `HTMLElement.outerText` | P1 | M | R | R |
| `HTMLElement.popover` | P1 | M | R | M |
| `HTMLElement.showPopover` | P1 | M | M | M |
| `HTMLElement.hidePopover` | P1 | M | M | M |
| `HTMLElement.togglePopover` | P1 | M | M | M |
| `HTMLDialogElement.showModal` | P1 | M | R | R |
| `HTMLDialogElement.show` | P1 | M | R | R |
| `HTMLDialogElement.close` | P1 | M | R | R |
| `HTMLDialogElement.returnValue` | P1 | M | R | R |
| `HTMLImageElement.decode` | P1 | M | R | R |
| `Blob.stream` | P1 | M | R | R |
| `Navigator.clipboard` | P1 | M | R | M |
| `window.matchMedia` | P1 | M | R | R |
| `window.requestIdleCallback` | P1 | M | M | M |
| `Document.adoptedStyleSheets` | P2 | M | C | M |
| `Document.execCommand` | P2 | M | M | M |
| `Document.designMode` | P2 | M | M | M |
| `Document.fonts` | P2 | M | M | M |

## Reverse census: present in happy-dom / oxidom, absent from jsdom

### happy-dom

- 152 global interfaces jsdom lacks: Animation, AnimationEvent, AnimationTimeline, AudioProcessingEvent, BeforeInputEvent, CanvasCaptureMediaStreamTrack, Clipboard, ClipboardEvent, ClipboardItem, CookieChangeEvent, CookieStore, CSSFontFaceLoadEvent, CSSKeywordValue, CSSStyleValue, CSSUnitValue, DataTransfer, DataTransferItem, DataTransferItemList, DeviceLightEvent, DeviceProximityEvent, DocumentTimeline, DOMMatrix, DOMMatrixReadOnly, DOMPoint, DOMPointReadOnly, DOMTransactionEvent, DragEvent, EditingBeforeInputEvent, FetchEvent, GamepadEvent, HTMLFormControlCollection, IDBVersionChangeEvent, ImageBitmap, ImageData, IntersectionObserver, IntersectionObserverEntry, KeyframeEffect, MediaQueryListEvent, MediaStream, MediaStreamEvent, MediaStreamTrack, MutationEvent, OfflineAudioCompletionEvent, OffscreenCanvas, OverconstrainedError, PaymentRequestUpdateEvent, Permissions, PermissionStatus, RelatedEvent, RemotePlayback, ResizeObserver, RTCDataChannelEvent, RTCIdentityErrorEvent, RTCIdentityEvent, RTCPeerConnectionIceEvent, ScreenDetailed, ScreenDetails, SensorEvent, StylePropertyMap, StylePropertyMapReadOnly, SVGAngle, SVGAnimatedAngle, SVGAnimatedBoolean, SVGAnimatedEnumeration, SVGAnimatedInteger, SVGAnimatedLength, SVGAnimatedLengthList, SVGAnimatedNumber, SVGAnimatedNumberList, SVGAnimatedTransformList, SVGAnimateElement, SVGAnimateMotionElement, SVGAnimateTransformElement, SVGAnimationElement, SVGCircleElement, SVGClipPathElement, SVGComponentTransferFunctionElement, SVGEllipseElement, SVGEvent, SVGFEBlendElement, SVGFEColorMatrixElement, SVGFEComponentTransferElement, SVGFECompositeElement, SVGFEConvolveMatrixElement, SVGFEDiffuseLightingElement, SVGFEDisplacementMapElement, SVGFEDistantLightElement, SVGFEDropShadowElement, SVGFEFloodElement, SVGFEFuncAElement, SVGFEFuncBElement, SVGFEFuncGElement, SVGFEFuncRElement, SVGFEGaussianBlurElement, SVGFEImageElement, SVGFEMergeElement, SVGFEMergeNodeElement, SVGFEMorphologyElement, SVGFEOffsetElement, SVGFEPointLightElement, SVGFESpecularLightingElement, SVGFESpotLightElement, SVGFETileElement, SVGFETurbulenceElement, SVGFilterElement, SVGForeignObjectElement, SVGGeometryElement, SVGGradientElement, SVGImageElement, SVGLength, SVGLengthList, SVGLinearGradientElement, SVGLineElement, SVGMarkerElement, SVGMaskElement, SVGMatrix, SVGMPathElement, SVGNumberList, SVGPathElement, SVGPatternElement, SVGPoint, SVGPointList, SVGPolygonElement, SVGPolylineElement, SVGRadialGradientElement, SVGRectElement, SVGScriptElement, SVGSetElement, SVGStopElement, SVGStyleElement, SVGTextElement, SVGTextPathElement, SVGTextPositioningElement, SVGTransform, SVGTransformList, SVGTSpanElement, SVGUnitTypes, SVGUseElement, SVGViewElement, SVGZoomEvent, TextEvent, TextTrack, TextTrackCue, TextTrackCueList, TextTrackList, TimeEvent, TimeRanges, Touch, TrackEvent, UserProximityEvent, VTTCue, WebGLContextEvent
- 34 other globals / Window members jsdom lacks (Node built-ins filtered out): attachEvent, closed, cookieStore, createImageBitmap, detachEvent, getScreenDetails, happyDOM, onanimationcancel, onanimationend, onanimationiteration, onanimationstart, onappinstalled, onbeforeinstallprompt, onbeforexrselect, oncommand, oncontentvisibilityautostatechange, ondevicemotion, ondeviceorientation, ondeviceorientationabsolute, ongamepadconnected, ongamepaddisconnected, onmousewheel, onpagereveal, onpageswap, onscrollsnapchange, onscrollsnapchanging, onsearch, onselectionchange, onselectstart, ontransitioncancel, ontransitionend, ontransitionrun, ontransitionstart, opener
- 178 interface members on shared interfaces that jsdom lacks (plus 0 underscore-internal names not listed):
  - Blob: stream
  - CSSRule: static CONTAINER_RULE, static DOCUMENT_RULE, static REGION_STYLE_RULE
  - CSSStyleRule: styleMap
  - Element: onfullscreenerror, onfullscreenchange, onbeforecopy, onbeforecut, onbeforepaste, onsearch, getInnerHTML, getHTML, setPointerCapture, hasPointerCapture, releasePointerCapture, scroll, scrollTo, scrollBy, scrollIntoView, checkVisibility, animate, getAnimations
  - HTMLAnchorElement: ping, referrerPolicy
  - HTMLAreaElement: download, referrerPolicy, ping
  - HTMLBodyElement: ongamepadconnected, ongamepaddisconnected
  - HTMLButtonElement: formAction, formEnctype, formMethod, popoverTargetElement, popoverTargetAction
  - HTMLCanvasElement: onwebglcontextcreationerror, onwebglcontextlost, onwebglcontextrestored, captureStream, transferControlToOffscreen
  - HTMLDialogElement: returnValue, close, showModal, show
  - HTMLElement: oncompositionend, oncompositionstart, oncompositionupdate, onfocusin, onfocusout, onanimationcancel, onanimationend, onanimationiteration, onanimationstart, ontransitioncancel, ontransitionend, ontransitionrun, ontransitionstart, contentEditable, isContentEditable, innerText, outerText, inert, popover, static observedAttributes
  - HTMLFormElement: encoding, autocomplete
  - HTMLIFrameElement: allow, sandbox, referrerPolicy
  - HTMLImageElement: loading, x, y, decoding, referrerPolicy, decode
  - HTMLInputElement: onselectionchange, formAction, formEnctype, formMethod, height, width, allowdirs, popoverTargetElement, popoverTargetAction
  - HTMLLinkElement: as, referrerPolicy
  - HTMLMediaElement: error, remote, sinkId, controlsList, mediaKeys, disableRemotePlayback, srcObject, preservesPitch, fastSeek, setMediaKeys, setSinkId, captureStream
  - HTMLObjectElement: contentWindow
  - HTMLScriptElement: blocking, fetchPriority, noModule, integrity, referrerPolicy, async, static supports
  - HTMLSlotElement: assign
  - HTMLSourceElement: height, width
  - HTMLTemplateElement: getInnerHTML, getHTML
  - HTMLTextAreaElement: onselectionchange
  - HTMLTrackElement: track
  - History: scrollRestoration
  - Navigator: credentials, geolocation, locks, maxTouchPoints, permissions, clipboard, webdriver, doNotTrack, sendBeacon
  - SVGElement: onanimationend, onanimationiteration, onanimationstart, onmousewheel, onscrollsnapchange, onscrollsnapchanging, onselectionchange, onselectstart, ontransitioncancel, ontransitionend, ontransitionrun, ontransitionstart
  - SVGGraphicsElement: transform, getBBox, getCTM, getScreenCTM
  - SVGSVGElement: ongamepadconnected, ongamepaddisconnected, height, width, x, y, currentScale, currentTranslate, pauseAnimations, unpauseAnimations, animationsPaused, getCurrentTime, setCurrentTime, getIntersectionList, getEnclosureList, checkIntersection, checkEnclosure, deselectAll, createSVGLength, createSVGAngle, createSVGPoint, createSVGMatrix, createSVGTransform, createSVGTransformFromMatrix
  - Selection: baseNode, baseOffset, extentNode, extentOffset
  - ShadowRoot: onslotchange, clonable, delegatesFocus, serializable, slotAssignment, fullscreenElement, pictureInPictureElement, pointerLockElement, adoptedStyleSheets, getAnimations, setHTMLUnsafe

### oxidom

- 5 global interfaces jsdom lacks: AnimationEvent, ClipboardEvent, DragEvent, MathMLElement, MediaQueryList
- 13 other globals / Window members jsdom lacks (Node built-ins filtered out): __oxidom, closed, onanimationcancel, onanimationend, onanimationiteration, onanimationstart, onselectionchange, onselectstart, ontransitioncancel, ontransitionend, ontransitionrun, ontransitionstart, opener
- numeric index accessors defined on prototypes (not API names; jsdom uses a proxy per instance): CSSStyleDeclaration 0..31, DOMTokenList 0..31, HTMLCollection 0..254, HTMLFormElement 0..255, HTMLOptionsCollection 0..254, HTMLSelectElement 0..255, NamedNodeMap 0..15
- 82 interface members on shared interfaces that jsdom lacks (plus 22 underscore-internal names not listed):
  - Document: onanimationstart, onanimationiteration, onanimationend, onanimationcancel, ontransitionrun, ontransitionstart, ontransitionend, ontransitioncancel, onselectionchange, onselectstart, domain, scrollingElement
  - HTMLAnchorElement: referrerPolicy, ping
  - HTMLAreaElement: download, hreflang, type, referrerPolicy, ping
  - HTMLButtonElement: formAction
  - HTMLDialogElement: returnValue, show, showModal, close
  - HTMLDocument: onanimationstart, onanimationiteration, onanimationend, onanimationcancel, ontransitionrun, ontransitionstart, ontransitionend, ontransitioncancel, onselectionchange, onselectstart, domain, scrollingElement
  - HTMLElement: innerText, outerText, contentEditable, isContentEditable, onanimationstart, onanimationiteration, onanimationend, onanimationcancel, ontransitionrun, ontransitionstart, ontransitionend, ontransitioncancel, onselectionchange, onselectstart
  - HTMLFormElement: encoding, autocomplete
  - HTMLImageElement: decode, loading, decoding
  - HTMLInputElement: formAction
  - HTMLLinkElement: as, sizes, integrity
  - History: scrollRestoration
  - Image: decode, loading, decoding
  - InputEvent: getTargetRanges
  - Navigator: maxTouchPoints, webdriver, doNotTrack, pdfViewerEnabled
  - Range: getBoundingClientRect, getClientRects
  - SVGElement: onanimationstart, onanimationiteration, onanimationend, onanimationcancel, ontransitionrun, ontransitionstart, ontransitionend, ontransitioncancel, onselectionchange, onselectstart
  - Screen: availLeft, availTop

