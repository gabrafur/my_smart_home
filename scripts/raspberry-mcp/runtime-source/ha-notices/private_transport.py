"""Fixed operations-process proxy; no secret files or arbitrary socket input."""
import json
import socket

SOCKET='/run/raspberry-private-notices/reader.sock'


def evidence(args):
    raw=json.dumps({'arguments':args},separators=(',',':')).encode()+b'\n'
    if len(raw)>16384:raise ValueError('private_request_limit')
    try:
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)as connection:
            connection.settimeout(5);connection.connect(SOCKET);connection.sendall(raw)
            reply=bytearray()
            while b'\n'not in reply:
                part=connection.recv(min(4096,20001-len(reply)))
                if not part:raise ValueError('private_reader_unavailable')
                reply.extend(part)
                if len(reply)>20000:raise ValueError('private_reply_limit')
            value=json.loads(bytes(reply).split(b'\n',1)[0])
            if type(value)is not dict or value.get('ok')is not True or 'result'not in value:raise ValueError('private_reader_invalid_response')
            return value['result']
    except(OSError,ValueError):
        return {'source':'private_household_notice_content_v1','state':'unknown','observed_at':None,'age_seconds':None,
            'collection_error':'private_reader_unavailable_or_not_activated','execution_authority':False,'recovery_proven':False,
            'coverage':['no_private_data_returned','closed_reader_route_required']}
