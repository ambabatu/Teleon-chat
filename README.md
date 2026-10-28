# TELEON Chat — Owner, Groups, Voice & Moderation Update

Telegram-inspired responsive web chat prototype using HTML/CSS/JavaScript, Express, Socket.IO, and JSON storage. It is intended for browser-first testing before a later Android wrapper.

## Included
- Account registration/login with bcrypt password hashes
- Username search and auto-saved direct chats
- Realtime text, image and voice-note messages using Socket.IO
- Persistent message history in the server's JSON store
- Profile bio and avatar upload
- Group creation UI with name, bio, profile photo, invite links, member list, adding usernames, admin management, kick with rejoin prevention, and group messages
- Group report workflow with Developer notification, report queue, and group blocking
- Developer-only username ban/unban controls; banned users cannot log in or reconnect
- Voice calls using WebRTC signaling and a public STUN server
- Reserved initial `Developer` account with `Owner` role and blue badge on a fresh store
- Owner panel to list registered users, show online status, grant/revoke Owner role and blue badge; only the reserved Developer account can ban users or groups
- 30-day session cookie and file-backed sessions
- Responsive desktop/mobile UI

## Run in Termux
```bash
pkg update
pkg install nodejs-lts unzip -y
cd ~
unzip -o /sdcard/Download/TELEON-Chat-Profile-Groups-Voice.zip -d ~
cd ~/TELEON
npm install
npm start
```
Open `http://127.0.0.1:3000` on the server phone.

## Test across devices
- Same Wi-Fi: open `http://SERVER_PHONE_LAN_IP:3000` from another device.
- Different networks: deploy this Node.js server to a public host with HTTPS or use a secure temporary tunnel. Termux alone does not automatically expose a server to the public internet.
- Browser microphone access for voice notes/calls generally requires HTTPS or localhost. WebRTC voice calls use STUN only here; some NATs/firewalls require a TURN server, so cross-network calls are not guaranteed until TURN is configured and tested.

## Groups
Tap the group icon (♧) to create a group. Add usernames separated by commas. The creator starts as admin. In a group, open the info button to view members, add members, share an invite link, report the group, edit name/bio/photo, and kick members. Group admins can manage members; only the group creator can assign admins. Kicked members cannot rejoin using the same invite code.

## Developer account
On a fresh data store, username `Developer` (stored as `developer`) and initial password `Aripganteng` are seeded as Owner and verified. Existing Developer account passwords are preserved. Change the initial password/setup before public hosting. Only this reserved Developer username can ban accounts or groups.

## Important limitations
- This is a starter prototype, not a production-secure messenger.
- JSON storage is suitable for small tests, not heavy concurrency or large communities. For scale, use PostgreSQL/SQLite with transactions, backups, rate limiting, HTTPS, monitoring, and object storage.
- Calls, voice notes, group links, and multi-device connectivity have not been tested on real devices in this environment. STUN-only WebRTC can fail on some networks; TURN is commonly needed for reliable cross-network calls.
- No end-to-end encryption, push notifications, group calls, or delivery/read receipts yet.
- Set `SESSION_SECRET` to a strong random value before public deployment.
