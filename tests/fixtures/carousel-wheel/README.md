These recorded wheel event fixtures come from [wheel-gestures](https://github.com/xiel/wheel-gestures), by Felix Leupold, under the accompanying MIT license. The JSON files are copied unchanged from version 2.3.0. Their contents match repository commit [`4c0592be090cf4e24370e9f3bde6080230791827`](https://github.com/xiel/wheel-gestures/tree/4c0592be090cf4e24370e9f3bde6080230791827/src/test/fixtures).

The `userAgent` metadata identifies the source recordings: Safari 13 on macOS 10.15 for the four vertical swipes, and Chrome 76 on macOS 10.15 for the double swipe. The upstream tests use these recordings to check momentum detection.

The carousel tests replay every delta with its recorded interval, advancing mocked timers between events. The `double-swipe-right.json` trace is explicitly rotated to the vertical axis in the test: original `deltaX` becomes `-deltaY`, and original `deltaY` becomes `deltaX`. This preserves magnitudes, timing, and the second swipe's restart during the first swipe's momentum. It models vertical carousel use without claiming the upstream recording was vertical.

The double swipe contains 103 events across 1,696 milliseconds. Its largest gap is only 39 milliseconds, so a 160-millisecond idle-only latch treats both swipes as one gesture. The second swipe starts while momentum is still arriving; a gesture detector must recognize that renewed input.

These are automated replays of recorded input, not tests performed with physical trackpad hardware in this workspace.
