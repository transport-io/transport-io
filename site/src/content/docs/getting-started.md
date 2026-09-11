---
title: Getting started
description: Install it, see it work, and pick where to go next.
sidebar:
  order: 0
---

## Install

```bash
npm install transport-io
```

The server also needs the native QUIC transport, installed separately:

```bash
npm install @fails-components/webtransport-transport-http3-quiche
```

It is not a dependency of anything, only a dynamic import, so no package manager will pull
it in for you. Browsers need nothing extra.

Two things about that native package affect CI. Its prebuilt binaries come from GitHub
Releases rather than npm. The Linux prebuild needs glibc 2.38, which no default Node `-slim`
image has, so use a `trixie` variant or Ubuntu 24.04.

You need **Node 22 or newer** and **TypeScript 5.0 or newer**. Chrome or Firefox: Safari
cannot talk to a quiche-backed server.

## See it work

One command, no project, no certificate, no configuration:

```bash
npx transport-io dev --demo
```

Open the printed URL in two tabs and type. Messages cross on the reliable lane and the
cursors follow on the unreliable one.

## Where next

[The tutorial](/tutorial/chat/) builds that page from an empty directory, one file at a
time, and ends at the chat example in the repository.

[The two lanes](/guides/lanes/) covers choosing between them, and
[`call()` and `stream()`](/guides/call-and-stream/) the request shapes.
[Certificates](/guides/certificates/) is what changes when you deploy.
[React](/guides/react/) is the binding, if that is what you are building in.
[Limitations](/limitations/) is worth reading before you commit to this.
