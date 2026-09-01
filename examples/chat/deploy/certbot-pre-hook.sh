#!/bin/sh
# /etc/letsencrypt/renewal-hooks/pre/transport-io-demo
# certbot's standalone authenticator needs TCP 80, which the demo holds. Stop it first.
# Runs only when a renewal is actually attempted, not on every timer tick.
set -eu
systemctl stop transport-io-demo.service
