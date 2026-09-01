#!/bin/sh
# /etc/letsencrypt/renewal-hooks/post/transport-io-demo
# Start the demo again. If a certificate was issued, the deploy hook has already copied it and
# the process starts with it. If none was, it starts with the one it had. Either way this is
# the restart that picks up a renewal: the QUIC binding has no certificate reload (D111).
set -eu
systemctl start transport-io-demo.service
