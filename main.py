import socketio
from aiohttp import web
import os
import base64
import uuid
from datetime import datetime, timezone
from collections import defaultdict

sio = socketio.AsyncServer(cors_allowed_origins="*", max_http_buffer_size=25 * 1024 * 1024)
app = web.Application()
sio.attach(app)

doBlockByIp = False  # Enable blocking by IP address

messages = {}  # {message_id: {sid, data, type, timestamp, room}}
chat_history = defaultdict(list)  # {room_name: [message_objects]}
connected_users = {}  # {sid: {alias, nickname, connect_time, last_disconnect_time, ip_address}}
ip_to_session = {}  # {ip_address: sid}
private_chats = {}  # {chat_id: {participants: [sid1, sid2], created_at, last_message_at}}
user_chat_rooms = defaultdict(set)  # {sid: {room1, room2, ...}}
room_participants = defaultdict(set)  # {room_name: {sid1, sid2, ...}}

def get_client_ip(environ):
    if 'HTTP_X_FORWARDED_FOR' in environ:
        ip = environ['HTTP_X_FORWARDED_FOR'].split(',')[0].strip()
        print(f"Extracted IP from X-Forwarded-For: {ip}")
        return ip
    elif 'HTTP_X_REAL_IP' in environ:
        return environ['HTTP_X_REAL_IP']
    elif 'HTTP_CF_CONNECTING_IP' in environ:
        return environ['HTTP_CF_CONNECTING_IP']
    else:
        return environ.get('REMOTE_ADDR', 'unknown')

def get_private_room_name(sid1, sid2):
    if sid1 == sid2:
        return f"private_room_{sid1}_{sid1}"
    else:
        return f"private_room_{min(sid1, sid2)}_{max(sid1, sid2)}"

def store_message_in_history(message_id, message_data):
    room = message_data.get('room', 'common_room')
    messages[message_id] = message_data
    chat_history[room].append({
        'id': message_id,
        'sid': message_data['sid'],
        'data': message_data['data'],
        'type': message_data['type'],
        'timestamp': message_data['timestamp'],
        'room': room
    })
    if room.startswith('private_room_'):
        if room not in private_chats:
            parts = room.replace('private_room_', '').split('_')
            if len(parts) >= 2:
                private_chats[room] = {
                    'participants': list(set(parts)),
                    'created_at': message_data['timestamp'],
                    'last_message_at': message_data['timestamp']
                }
        else:
            private_chats[room]['last_message_at'] = message_data['timestamp']

def get_room_history(room_name, since_timestamp=None, limit=100):
    if room_name not in chat_history:
        return []
    room_messages = chat_history[room_name]
    if since_timestamp:
        room_messages = [msg for msg in room_messages if msg['timestamp'] > since_timestamp]
    return room_messages[-limit:] if limit else room_messages

def cleanup_user_data(sid):
    if sid in user_chat_rooms:
        user_rooms = user_chat_rooms[sid].copy()
        for room in user_rooms:
            if room in room_participants:
                room_participants[room].discard(sid)
                if not room_participants[room] and room != 'common_room':
                    del room_participants[room]
        del user_chat_rooms[sid]

@sio.event
async def connect(sid, environ):
    client_ip = get_client_ip(environ)
    print(f'Client {sid} attempting to connect from IP {client_ip}')
    
    if doBlockByIp and client_ip in ip_to_session:
        existing_sid = ip_to_session[client_ip]
        if existing_sid in connected_users:
            print(f'Connection rejected: IP {client_ip} already has active session {existing_sid}')
            await sio.emit('connection_rejected', {
                'reason': 'IP_ALREADY_CONNECTED',
                'message': 'Only one connection per IP address is allowed'
            }, to=sid)
            await sio.disconnect(sid)
            return
        else:
            del ip_to_session[client_ip]
    
    print(f'Client {sid} connected to common room from IP {client_ip}')
    await sio.enter_room(sid, 'common_room')
    
    connected_users[sid] = {
        'alias': sid[:8],
        'nickname': '',
        'connect_time': datetime.now(timezone.utc).isoformat(),
        'last_disconnect_time': None,
        'ip_address': client_ip
    }
    
    ip_to_session[client_ip] = sid
    room_participants['common_room'].add(sid)
    user_chat_rooms[sid].add('common_room')
    
    await sio.emit('users_update', {
        'users': [{'sid': user_sid, 'alias': user_data['alias'], 'nickname': user_data['nickname']} 
                 for user_sid, user_data in connected_users.items()]
    }, room='common_room')

@sio.event
async def disconnect(sid):
    print(f'Client {sid} disconnected from the common room')
    await sio.leave_room(sid, 'common_room')
    
    user_data = connected_users.get(sid)
    if user_data:
        user_data['last_disconnect_time'] = datetime.now(timezone.utc).isoformat()
        client_ip = user_data['ip_address']
        print(f"Stored last_disconnect_time for {sid} (IP: {client_ip}): {user_data['last_disconnect_time']}")
        if client_ip in ip_to_session and ip_to_session[client_ip] == sid:
            del ip_to_session[client_ip]
            print(f"Removed IP mapping for {client_ip}")
    
    for room_name in list(sio.manager.get_rooms(sid, '/')):
        if room_name.startswith('private_room_'):
            await sio.leave_room(sid, room_name)
            print(f"User {sid} left private room: {room_name}")
    
    cleanup_user_data(sid)
    if sid in connected_users:
        del connected_users[sid]
    
    await sio.emit('users_update', {
        'users': [{'sid': user_sid, 'alias': user_data['alias'], 'nickname': user_data['nickname']} 
                 for user_sid, user_data in connected_users.items()]
    }, room='common_room')

@sio.event
async def message(sid, data):
    print(f'Received message from {sid} for room {data.get("room")}: {data}')
    message_id = str(uuid.uuid4())
    message_type = data.get('type', 'text')
    message_content = data.get('data', '') if isinstance(data, dict) else data
    timestamp = data.get('timestamp', datetime.now(timezone.utc).isoformat())
    room = data.get('room', 'common_room')

    message_data = {
        'sid': sid,
        'data': message_content,
        'type': message_type,
        'timestamp': timestamp,
        'room': room
    }

    store_message_in_history(message_id, message_data)

    user_data = connected_users.get(sid, {})
    
    await sio.emit('message', {
        'id': message_id,
        'sid': sid,
        'nickname': user_data.get('nickname', ''),
        'alias': user_data.get('alias', sid[:8]),
        'data': message_content,
        'type': message_type,
        'timestamp': timestamp,
        'room': room
    }, room=room)

@sio.event
async def join_private_chat(sid, data):
    target_sid = data.get('target_sid')
    
    if not target_sid or not isinstance(target_sid, str):
        print(f"Error: Invalid target_sid provided by {sid}: {target_sid}")
        await sio.emit('error', {'message': "Invalid target user specified"}, to=sid)
        return
    
    if target_sid != sid and target_sid not in connected_users:
        print(f"Error: Target user {target_sid} not found in connected users")
        await sio.emit('error', {'message': f"User {target_sid} not found"}, to=sid)
        return
    
    room_name = get_private_room_name(sid, target_sid)
    print(f"User {sid} joining private room: {room_name} with {target_sid}")
    
    current_rooms = sio.manager.get_rooms(sid, '/')
    if room_name not in current_rooms:
        await sio.enter_room(sid, room_name)
        print(f"User {sid} entered room {room_name}")
        room_participants[room_name].add(sid)
        user_chat_rooms[sid].add(room_name)
    
    if target_sid != sid and target_sid in connected_users:
        target_rooms = sio.manager.get_rooms(target_sid, '/')
        if room_name not in target_rooms:
            await sio.enter_room(target_sid, room_name)
            print(f"User {target_sid} entered room {room_name}")
            room_participants[room_name].add(target_sid)
            user_chat_rooms[target_sid].add(room_name)
            
            initiator_user = connected_users[sid]
            target_user = connected_users[target_sid]
            
            initiator_name = initiator_user.get('nickname') or initiator_user.get('alias', sid[:8])
            target_name = target_user.get('nickname') or target_user.get('alias', target_sid[:8])
            
            await sio.emit('private_chat_invitation', {
                'room_name': room_name,
                'initiator_sid': sid,
                'initiator_name': initiator_name,
                'target_sid': target_sid,
                'target_name': target_name
            }, to=target_sid)
    
    last_disconnect_time = connected_users.get(sid, {}).get('last_disconnect_time', None)
    room_messages = get_room_history(room_name, since_timestamp=last_disconnect_time)
    
    formatted_messages = []
    for msg in room_messages:
        user_data = connected_users.get(msg['sid'], {})
        formatted_messages.append({
            'id': msg['id'],
            'sid': msg['sid'],
            'nickname': user_data.get('nickname', ''),
            'alias': user_data.get('alias', msg['sid'][:8]),
            'data': msg['data'],
            'type': msg.get('type'),
            'timestamp': msg.get('timestamp'),
            'room': msg.get('room')
        })
    
    await sio.emit('chat_history_response', {
        'room_name': room_name,
        'messages': formatted_messages,
        'total_count': len(chat_history.get(room_name, []))
    }, to=sid)
    
    if target_sid == sid:
        user_data = connected_users[sid]
        target_name = f"{user_data.get('nickname') or user_data.get('alias', sid[:8])} (Personal Time)"
    else:
        target_user = connected_users[target_sid]
        target_name = target_user.get('nickname') or target_user.get('alias', target_sid[:8])
    
    await sio.emit('private_chat_joined', {
        'room_name': room_name,
        'target_sid': target_sid,
        'target_name': target_name
    }, to=sid)
    
    print(f"Successfully joined private chat: {room_name}")

@sio.event
async def set_nickname(sid, data):
    nickname = data.get('nickname', '').strip()
    if sid in connected_users:
        connected_users[sid]['nickname'] = nickname
        await sio.emit('users_update', {
            'users': [{'sid': user_sid, 'alias': user_data['alias'], 'nickname': user_data['nickname']} 
                     for user_sid, user_data in connected_users.items()]
        }, room='common_room')
        await sio.emit('nickname_updated', {
            'sid': sid,
            'nickname': nickname
        }, room='common_room')

@sio.event
async def join_common_room(sid):
    print(f"User {sid} joining common room")
    await sio.enter_room(sid, 'common_room')
    room_participants['common_room'].add(sid)
    user_chat_rooms[sid].add('common_room')
    
    room_messages = get_room_history('common_room', limit=100)
    
    formatted_messages = []
    for msg in room_messages:
        user_data = connected_users.get(msg['sid'], {})
        formatted_messages.append({
            'id': msg['id'],
            'sid': msg['sid'],
            'nickname': user_data.get('nickname', ''),
            'alias': user_data.get('alias', msg['sid'][:8]),
            'data': msg['data'],
            'type': msg['type'],
            'timestamp': msg['timestamp'],
            'room': msg['room']
        })
    
    await sio.emit('chat_history_response', {
        'room_name': 'common_room',
        'messages': formatted_messages,
        'total_count': len(chat_history.get('common_room', []))
    }, to=sid)

@sio.event
async def edit_message(sid, data):
    message_id = data.get('id')
    new_content = data.get('data')
    if message_id in messages and messages[message_id]['sid'] == sid:
        messages[message_id]['data'] = new_content
        room = messages[message_id]['room']
        if room in chat_history:
            for msg in chat_history[room]:
                if msg['id'] == message_id:
                    msg['data'] = new_content
                    break
        await sio.emit('message_edited', {
            'id': message_id,
            'data': new_content
        }, room=room)

@sio.event
async def delete_message(sid, data):
    message_id = data.get('id')
    if message_id in messages and messages[message_id]['sid'] == sid:
        room = messages[message_id]['room']
        del messages[message_id]
        if room in chat_history:
            chat_history[room] = [msg for msg in chat_history[room] if msg['id'] != message_id]
        await sio.emit('message_deleted', {'id': message_id}, room=room)

@sio.event
async def leave_private_chat(sid, data):
    room_name = data.get('room_name')
    if room_name and room_name.startswith('private_room_'):
        await sio.leave_room(sid, room_name)
        if room_name in room_participants:
            room_participants[room_name].discard(sid)
        if sid in user_chat_rooms:
            user_chat_rooms[sid].discard(room_name)
        print(f"User {sid} left private room: {room_name}")

@sio.event
async def get_chat_history(sid, data):
    room_name = data.get('room_name', 'common_room')
    limit = data.get('limit', 50)
    since_timestamp = data.get('since_timestamp')
    
    print(f"User {sid} requesting chat history for room: {room_name}")
    room_messages = get_room_history(room_name, since_timestamp, limit)
    
    formatted_messages = []
    for msg in room_messages:
        user_data = connected_users.get(msg['sid'], {})
        formatted_messages.append({
            'id': msg['id'],
            'sid': msg['sid'],
            'nickname': user_data.get('nickname', ''),
            'alias': user_data.get('alias', msg['sid'][:8]),
            'data': msg['data'],
            'type': msg['type'],
            'timestamp': msg['timestamp'],
            'room': msg['room']
        })
    
    await sio.emit('chat_history_response', {
        'room_name': room_name,
        'messages': formatted_messages,
        'total_count': len(chat_history.get(room_name, []))
    }, to=sid)

@sio.event
async def get_user_info(sid, data):
    user_info = []
    for user_sid, user_data in connected_users.items():
        user_info.append({
            'sid': user_sid,
            'alias': user_data['alias'],
            'nickname': user_data['nickname'],
            'connect_time': user_data['connect_time'],
            'ip_address': user_data['ip_address'],
            'active_rooms': list(user_chat_rooms.get(user_sid, set()))
        })
    
    await sio.emit('user_info_response', {'users': user_info}, to=sid)

@sio.event
async def get_chat_stats(sid, data):
    stats = {
        'total_messages': len(messages),
        'total_rooms': len(chat_history),
        'active_private_chats': len([room for room in private_chats.keys() if len(room_participants.get(room, set())) > 0]),
        'connected_users': len(connected_users),
        'room_message_counts': {room: len(msgs) for room, msgs in chat_history.items()},
        'private_chat_info': {
            room: {
                'participants': len(room_participants.get(room, set())),
                'message_count': len(chat_history.get(room, [])),
                'last_message': info.get('last_message_at'),
                'created_at': info.get('created_at')
            }
            for room, info in private_chats.items()
        }
    }
    
    await sio.emit('chat_stats_response', stats, to=sid)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


async def index(request):
    print(f'Serving index: {request.path}')
    return web.FileResponse(os.path.join(BASE_DIR, 'index.html'))

async def sw(request):
    print(f'Serving sw: {request.path}')
    return web.FileResponse(os.path.join(BASE_DIR, 'sw.js'))

async def push(request):
    print(f'Serving push: {request.path}')
    return web.FileResponse(os.path.join(BASE_DIR, 'push-notifications.js'))

async def manifest(request):
    print(f'Serving manifest: {request.path}')
    return web.FileResponse(os.path.join(BASE_DIR, 'manifest.json'))

async def script(request):
    print(f'Serving script: {request.path}')
    return web.FileResponse(os.path.join(BASE_DIR, 'script.js'))

async def socket(request):
    print(f'Serving socket: {request.path}')
    return web.FileResponse(os.path.join(BASE_DIR, 'socket.io.js'))

async def favicon(request):
    print(f'Favicon requested: {request.path}')
    # favicon_path = os.path.join(BASE_DIR, 'favicon.ico')
    # if not os.path.exists(favicon_path):
    #     print(f'Error: favicon.ico not found at {favicon_path}')
    #     raise web.HTTPNotFound()
    return web.FileResponse(os.path.join(BASE_DIR, 'favicon.ico'))

async def style(request):
    style_path = os.path.join(BASE_DIR, 'styles.css')
    if not os.path.exists(style_path):
        raise web.HTTPNotFound()
    return web.FileResponse(style_path)

app.router.add_get('/', index)
app.router.add_get('/favicon.ico', favicon)
app.router.add_get('/manifest.json', manifest)
app.router.add_get('/styles.css', style)
app.router.add_get('/script.js', script)
app.router.add_get('/socket.io.js', socket)
app.router.add_get('/sw.js', sw)
app.router.add_get('/push-notifications.js', push)

if __name__ == '__main__':
    web.run_app(app, port=5555, host='0.0.0.0')