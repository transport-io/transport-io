#!/bin/sh
# /etc/letsencrypt/renewal-hooks/deploy/transport-io-demo
# /etc/letsencrypt/live is root-only. Copy what the demo user needs, with the permissions the
# demo user needs, and nothing else. Runs only after a certificate was actually issued.
set -eu
: "${RENEWED_LINEAGE:?certbot sets this}"
DEST=/var/lib/transport-io-demo/cert
install -d -o transport-io -g transport-io -m 0750 "$DEST"
install -o transport-io -g transport-io -m 0640 "$RENEWED_LINEAGE/fullchain.pem" "$DEST/fullchain.pem"
install -o transport-io -g transport-io -m 0640 "$RENEWED_LINEAGE/cert.pem"      "$DEST/cert.pem"
install -o transport-io -g transport-io -m 0600 "$RENEWED_LINEAGE/privkey.pem"   "$DEST/privkey.pem"
