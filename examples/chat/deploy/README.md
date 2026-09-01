# The public demo: design and runbook

Nothing in this directory has been provisioned, bought or deployed. It is the design, the
configuration, and the steps, for a person to run. Every file here is referenced below by the
path it lands at on the machine.

## Read this first, and again at 2am

Two things will look like faults and are not.

1. **Every renewal drops every session.** The QUIC binding has no certificate reload, so the
   certbot hooks stop and start the process. About every sixty days, for ten seconds or so,
   the demo restarts and every visitor reconnects. `journalctl -u transport-io-demo` shows
   the pre-hook announcing it. D111.
2. **The `wt` health step may refuse the certificate.** It pins the on-disk certificate's hash
   because the Node client has no other way to connect, and the browser rule caps a pinned
   certificate at fourteen days. Whether the Node binding enforces that cap against a
   ninety-day Let's Encrypt certificate is **not known**. If `/healthz` shows `wt` failing on
   validity while the page works in a browser, the demo is fine and the probe is not. The fix
   is in "Known unknowns": a 160-hour certificate, requested with `--required-profile`.

## What you need

Nothing here assumes anything already bought.

| need | exactly | notes |
|---|---|---|
| a VPS | any provider that gives a public IPv4 and does not filter UDP. Smallest Ubuntu 24.04 instance; one shared vCPU and one gigabyte is enough | Not Railway: its public networking documents HTTP and HTTPS only. Fly can do UDP, but the app must bind `fly-global-services` rather than `0.0.0.0`, needs a dedicated IPv4, and has no public IPv6 UDP; this server would need those two changes first, so a plain VPS is the design. |
| a hostname | a domain or subdomain whose DNS you control | `demo.example.com` throughout this directory |
| DNS | **one `A` record** to the VPS's IPv4, proxying off | No `AAAA`: the server binds IPv4 only. Publish one only after binding `::` and verifying the binding on it. |
| a certificate | Let's Encrypt, via certbot from apt | Free. certbot asks for an email at first issuance. |
| access | SSH to the VPS as a sudoer | |

No CDN, no load balancer, no proxy, and no managed certificate: each of those either
terminates TLS or drops UDP, and both end the demo.

## What it is

One plain VPS. DNS with A and AAAA records only, nothing proxying in front of it, because a
proxy terminates TLS and drops UDP, and UDP is the whole point. One Node process holds three
listeners: TCP 80 to redirect, TCP 443 for the two pages over HTTPS, and UDP 443 for
WebTransport. The certificate is from Let's Encrypt and nothing pins its hash. That is the
production path this library documents and has never run end to end. This is its first test,
and the checklist at the end is how to know it passed.

| file | lands at |
|---|---|
| `server.node.ts` | `/opt/transport-io/examples/chat/deploy/server.node.ts` |
| `healthcheck.node.ts` | `/opt/transport-io/examples/chat/deploy/healthcheck.node.ts` |
| `transport-io-demo.service` | `/etc/systemd/system/` |
| `transport-io-demo-health.service`, `.timer` | `/etc/systemd/system/` |
| `transport-io-demo-restart.service`, `transport-io-demo-daily.timer` | `/etc/systemd/system/` |
| `certbot-pre-hook.sh` | `/etc/letsencrypt/renewal-hooks/pre/transport-io-demo` |
| `certbot-deploy-hook.sh` | `/etc/letsencrypt/renewal-hooks/deploy/transport-io-demo` |
| `certbot-post-hook.sh` | `/etc/letsencrypt/renewal-hooks/post/transport-io-demo` |

Replace `demo.example.com` in the two unit files with the real name before installing them.

## Why no certificate hash

`serverCertificateHashes` is capped at fourteen days of validity. A public demo pinned to one
would break silently on the fifteenth day, in exactly the way KNOWN-ISSUES.md describes as
indistinguishable from a server that is down. So the browser validates against the platform
CA store, the way it validates any HTTPS origin, and the page's `connectBrowser` call passes
`url` and nothing else.

## Provisioning, not performed

1. Ubuntu 24.04. Its glibc is 2.39, above the 2.38 the native prebuild needs. Do not use a
   Debian bookworm image or any default Node `-slim` image; see the README's install section.
2. Node 22 from NodeSource. `sudo useradd --system --home /var/lib/transport-io-demo
   --create-home transport-io`.
3. `sudo git clone https://github.com/transport-io/transport-io /opt/transport-io`, then in it:
   `npm ci`, `npm run build`, `npm install @fails-components/webtransport-transport-http3-quiche`,
   and `cd examples/chat && bun run build:web` (Bun is only needed for that one build; do it
   on your machine and `rsync` `examples/chat/web/dist` up if you would rather not install
   Bun on the server). `sudo chown -R transport-io:transport-io /opt/transport-io`.
4. Firewall: `ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp`. The third one is
   the one people forget, and without it the page loads and the demo does not.
5. DNS: one `A` record for the host, proxying off. No `AAAA`; see "What you need".
6. Certificate, first issuance, with the demo not yet running so port 80 is free:
   ```
   sudo certbot certonly --standalone --key-type ecdsa -d demo.example.com
   ```
   Then run the deploy hook once by hand, because certbot only runs it on renewal:
   ```
   sudo RENEWED_LINEAGE=/etc/letsencrypt/live/demo.example.com \
     /etc/letsencrypt/renewal-hooks/deploy/transport-io-demo
   ```
7. Install the hooks (`chmod +x`), the units, then `systemctl daemon-reload`, `systemctl enable
   --now transport-io-demo.service transport-io-demo-health.timer transport-io-demo-daily.timer`.
8. Wait two minutes for the first health run, then open `https://demo.example.com/healthz`.
   Every step should read `ok`. Then the checklist at the end.

## Renewal, and why the server restarts

certbot's own timer runs `certbot renew` twice a day and does nothing until the certificate
has thirty days left. When it does renew:

1. the **pre** hook stops the demo, freeing TCP 80 for the standalone authenticator;
2. certbot obtains the certificate;
3. the **deploy** hook copies `fullchain.pem`, `cert.pem` and `privkey.pem` into
   `/var/lib/transport-io-demo/cert`, owned by the demo user, because `/etc/letsencrypt/live`
   is root-only and the service runs without root;
4. the **post** hook starts the demo, which reads the new files at startup.

**This is a restart, not a reload, and it is not optional.** The QUIC binding this library
uses has no way to change its certificate while running: the umbrella package exposes
`updateCert()` and calls it only `if (transport.updateCert)`, and the quiche transport package
does not define one. D111 records the check. So every live session drops once per renewal,
about every sixty days, for the ten seconds or so the sequence takes, and clients reconnect.
For a demo that is fine, and it is stated here so nobody goes looking for a reload that does
not exist.

The health check's `cert` step is what proves the restart happened with the new certificate:
it compares the certificate the TCP listener presents against `cert.pem` on disk, and both
listeners read the same files at startup.

## Idle for days

Nothing happens, and nothing needs to. The process is event-driven, the generator streams end
on their own after about twenty seconds, and the QUIC idle timeout closes abandoned sessions.
The periodic work is certbot's timer, the health timer, and the daily restart.

The daily restart exists because of the one measured defect: each bidirectional stream leaks
about 5.95 KB in the binding. The health check opens one call stream per minute, which alone
is 1440 streams a day, under 9 MB at that figure, and visitors add to it with use rather than
with time. A restart at 04:00 bounds it to one day's worth regardless of traffic. It drains the
same way a renewal does.

## Caps

A public URL must not be a way to make the server do unbounded work. Three bounds, none of
them the library's business:

| bound | value | where |
|---|---|---|
| concurrent sessions | 32 | `server.node.ts`, before `accept`; the 33rd is closed with reason `demo at capacity` |
| concurrent `generate` streams per session | 4 | `app.ts`, the call errors past it |
| streams per session, of any kind | 256 | the library, `WT_TOO_MANY_STREAMS` |

Worst case is 128 generators at once, each yielding about twenty tokens a second, which is
nothing. There is no per-address limit because the connection does not expose the peer
address to this code, and a limit that is easy to evade is not worth documenting as one.

## The health check, and failing loudly

`healthcheck.node.ts` runs every minute from a systemd timer and writes every step's result to
`/var/lib/transport-io-demo/health.json`. Two things read it:

- **systemd.** A non-zero exit triggers `transport-io-demo-restart.service`, a oneshot, so a
  broken demo restarts itself within a minute and cannot restart faster than the timer.
- **The page server.** Before serving any `.html`, it reads the file. If the last run failed,
  or is older than three minutes, or does not exist, it answers **503** with the failing step
  in plain text. A dead timer therefore takes the page down too, rather than leaving a
  loading page in front of a dead transport. `/healthz` returns the JSON, 200 or 503.

The four steps and what each proves are in the file's header comment.

## The packet-loss toggle

The chat page now has a slider: drop this share of my cursor frames. The server applies it
before broadcasting, so the **other** window watches cursor frames vanish while every chat
message still arrives, and each window counts what it received on each lane. It is simulated
at the server and the page says so. A frame the network lost and a frame dropped there are
the same frame to every other window, which is what makes the simulation an honest one, and it
is the only kind a browser can trigger.

For a recording with real loss, on the VPS:

```
sudo tc qdisc add dev eth0 root netem loss 20%
sudo tc qdisc del dev eth0 root
```

That drops a fifth of everything, in both directions. The reliable lane recovers through QUIC
retransmission and the chat still arrives one for one; cursors thin out. It is the same
picture as the slider, from a cause nobody can accuse of being staged.

## Known unknowns

Stated so they are found on purpose rather than by a visitor.

- **The production path has never run.** A browser talking to this library with a CA
  certificate and no hash is documented and untested. The checklist below is the test.
- **The `wt` health step pins a ninety-day certificate.** The Node client requires a hash, and
  the browser rule caps a pinned certificate at fourteen days. Whether the Node binding
  enforces the same cap is not known. If the step fails naming validity, either drop to the
  other three steps and rely on the checklist for the transport, or switch the certificate to
  Let's Encrypt's `shortlived` profile, which is 160 hours, fits the cap, and means a restart
  about every three days. Request it with `--required-profile shortlived`, not
  `--preferred-profile`: the preferred form falls back to the default profile silently, which
  would hand you a ninety-day certificate and the same failing probe with no message saying
  why. Profiles: https://letsencrypt.org/docs/profiles/
- **The binding's `secret` option** is left at the library default. What it protects is not
  documented by the binding and this runbook does not guess.

## First deploy checklist

In order. Steps one to eight are "Provisioning, not performed" above; this is what to check
once the units are up. The point of this is the first bullet. Do not skip it because the
health check is green.

- [ ] In Chrome, open `https://demo.example.com/agents.html`. Both panels stream. In devtools,
      Network, the WebTransport session is listed and established. No certificate warning.
- [ ] In Firefox, the same.
- [ ] Press stop under one panel. The other's counter keeps climbing. `journalctl -u
      transport-io-demo` shows `generate agent-a: cancelled after N tokens`.
- [ ] Open `/` in two windows. Set the slider to 100% in one, move the pointer, watch the other
      window's cursor count stay put and its chat count still climb.
- [ ] `https://demo.example.com/healthz` is 200 and every step is `ok`, including `wt`. If
      `wt` is not, read "Known unknowns" before changing anything.
- [ ] `sudo systemctl restart transport-io-demo` while a panel is streaming. The page reloads
      into a working demo within a few seconds. That is the renewal path, rehearsed.
- [ ] Open a 33rd session (a script, not 33 tabs) and confirm it is refused with `demo at
      capacity` rather than accepted.

## Cost

One shared vCPU and one gigabyte is more than this needs. The process idles near zero, the
memory ceiling is set by the daily restart, and the bandwidth is a few kilobytes a second per
visitor while a panel streams.
