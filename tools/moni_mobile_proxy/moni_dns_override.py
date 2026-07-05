#!/usr/bin/env python3
"""Small DNS override server for Moni Mobile capture tests."""

from __future__ import annotations

import argparse
import ipaddress
import socket
import socketserver
import struct


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Serve a temporary DNS override for one hostname and forward "
            "all other UDP DNS queries to an upstream resolver."
        )
    )
    parser.add_argument("--listen-host", default="0.0.0.0")
    parser.add_argument("--listen-port", type=int, default=53)
    parser.add_argument("--host", default="alarmsystem.dyndns.biz")
    parser.add_argument("--ip", default="192.168.0.205")
    parser.add_argument("--upstream", default="1.1.1.1")
    parser.add_argument("--upstream-port", type=int, default=53)
    return parser.parse_args()


def read_qname(packet: bytes, offset: int = 12) -> tuple[str, int]:
    labels: list[str] = []
    while True:
        length = packet[offset]
        offset += 1
        if length == 0:
            break
        labels.append(packet[offset : offset + length].decode("ascii", errors="ignore"))
        offset += length
    return ".".join(labels).lower(), offset


def build_a_response(query: bytes, ip: str) -> bytes:
    question_name, question_end = read_qname(query)
    question = query[12 : question_end + 4]
    transaction_id = query[:2]
    flags = b"\x81\x80"
    counts = struct.pack("!HHHH", 1, 1, 0, 0)
    answer_name = b"\xc0\x0c"
    answer_type_class = struct.pack("!HHI", 1, 1, 30)
    address = ipaddress.IPv4Address(ip).packed
    answer = answer_name + answer_type_class + struct.pack("!H", len(address)) + address
    return transaction_id + flags + counts + question + answer


def forward_query(query: bytes, upstream: tuple[str, int]) -> bytes | None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as upstream_socket:
        upstream_socket.settimeout(3)
        upstream_socket.sendto(query, upstream)
        try:
            response, _ = upstream_socket.recvfrom(4096)
            return response
        except TimeoutError:
            return None


def make_handler(args: argparse.Namespace) -> type[socketserver.BaseRequestHandler]:
    override_host = args.host.rstrip(".").lower()
    override_ip = args.ip
    upstream = (args.upstream, args.upstream_port)

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            query, server_socket = self.request
            client = self.client_address
            response = None

            try:
                qname, question_end = read_qname(query)
                qtype = struct.unpack("!H", query[question_end : question_end + 2])[0]
            except Exception:
                qname = ""
                qtype = 0

            if qname == override_host and qtype == 1:
                print(f"override {qname} A -> {override_ip} for {client[0]}")
                response = build_a_response(query, override_ip)
            else:
                response = forward_query(query, upstream)

            if response:
                server_socket.sendto(response, client)

    return Handler


def main() -> None:
    args = parse_args()
    server = socketserver.ThreadingUDPServer(
        (args.listen_host, args.listen_port),
        make_handler(args),
    )
    print(
        f"DNS listening on {args.listen_host}:{args.listen_port}; "
        f"{args.host} -> {args.ip}; forwarding to {args.upstream}:{args.upstream_port}"
    )
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
