#!/bin/sh
# /etc/letsencrypt/renewal-hooks/pre/transport-io-demo
# certbot's standalone authenticator needs TCP 80, which the demo holds. Stop it first.
# Runs only when a renewal is actually attempted, not on every timer tick.
set -eu
echo "transport-io-demo: stopping for certificate renewal. Every live session drops now;" \
     "the QUIC binding cannot reload a certificate, so this is a restart by design (D111)."
systemctl stop transport-io-demo.service
