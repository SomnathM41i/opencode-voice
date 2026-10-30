#!/bin/sh
# Issues the HTTPS certificate for the LAN gateway. Usage: lan-cert.sh IP:10.0.0.5,IP:...
#
# The phone trusts ca.crt once; server certificates are reissued from it when the
# laptop's address changes. The CA is limited to private IP addresses, so even if
# ca.key leaked it could not impersonate a public website to the phone.
set -eu

san=$1
mkdir -p .lan
cd .lan

if [ ! -f ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
    -keyout ca.key -out ca.crt -subj "/CN=OpenCode Voice Local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0" \
    2>/dev/null
fi

cat > server.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
  -subj "/CN=OpenCode Voice" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 365 -sha256 -extfile server.ext -out server.crt 2>/dev/null
rm -f server.csr server.ext
