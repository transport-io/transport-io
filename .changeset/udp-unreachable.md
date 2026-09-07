---
'transport-io': minor
---

A failed handshake now asks whether the same origin answers over HTTPS, and reports
`WT_UDP_UNREACHABLE` when it does: the server is up over TCP and only the QUIC path is
failing, which is what a firewall, a VPN or a platform with no UDP ingress looks like.
`WT_HANDSHAKE_FAILED` is unchanged where nothing answers, and its message says so. The probe
runs only after the failure. `connectBrowser` and `connectHttp3` take `probe` to override the
target or `false` to skip it; `connectDev` skips it. A failed `connectHttp3` raised
`WT_SESSION_CLOSED` before and now raises the same two codes as the browser connector.
