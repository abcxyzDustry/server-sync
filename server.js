const http = require('http');
const { MongoClient } = require('mongodb');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BACKEND_SECRET = process.env.BACKEND_SECRET || 'plague-network-2026';
const TRUST_SECRET = process.env.TRUST_SECRET || 'trust-sync-2026';
const OFFLINE_MS = parseInt(process.env.OFFLINE_MS || '90000', 10);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'crab';
const MAX_SERVERS = 200;
const MAX_MESSAGES = 200;
const MESSAGE_TTL_SECONDS = 15 * 60;
const SERVER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 2 * 1024 * 1024;

let db = null;
let colServers = null;
let colScores = null;
let colMessages = null;

function connectMongo() {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    client.connect().then(async () => {
        const m = client.db(MONGODB_DB);
        await m.command({ ping: 1 });
        colServers = m.collection('servers');
        colScores = m.collection('scores');
        colMessages = m.collection('messages');
        await colServers.createIndex({ name: 1 }, { unique: true });
        await colScores.createIndex({ uuid: 1 }, { unique: true });
        await colMessages.createIndex({ ts: 1 }, { expireAfterSeconds: MESSAGE_TTL_SECONDS });
        db = m;
        console.log('[mongo] connected: ' + MONGODB_DB);
        pruneOldServers().catch(() => {});
    }).catch(e => {
        console.log('[mongo] connect failed: ' + e.message + ' - retry in 10s');
        setTimeout(connectMongo, 10000);
    });
}

async function pruneOldServers() {
    if (!db) return;
    const r = await colServers.deleteMany({ lastSeen: { $lt: Date.now() - SERVER_RETENTION_MS } });
    if (r.deletedCount) console.log('[prune] removed ' + r.deletedCount + ' stale servers');
}

function clean(v, fallback) {
    const s = String(v == null ? '' : v).replace(/[|\r\n]/g, ' ').trim().slice(0, 80);
    return s || (fallback === undefined ? '' : fallback);
}

function chatText(v) {
    return String(v == null ? '' : v).replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

function isOnline(s, now) {
    return now - (s.lastSeen || 0) < OFFLINE_MS;
}

function sortServers(list, now) {
    return list.sort((a, b) => {
        const oa = isOnline(a, now) ? 1 : 0;
        const ob = isOnline(b, now) ? 1 : 0;
        if (oa !== ob) return ob - oa;
        if ((b.players || 0) !== (a.players || 0)) return (b.players || 0) - (a.players || 0);
        return String(a.name).localeCompare(String(b.name));
    });
}

async function serverLines() {
    const now = Date.now();
    const list = await colServers.find({}, { projection: { _id: 0 }, limit: MAX_SERVERS * 4 }).toArray();
    return sortServers(list, now).slice(0, MAX_SERVERS).map(s => [
        clean(s.name),
        clean(s.ip),
        s.port || 6567,
        clean(s.mode),
        s.players || 0,
        isOnline(s, now) ? 1 : 0,
        clean(s.desc)
    ].join('|')).join('\n');
}

async function handleRegister(body) {
    const name = clean(body.name, 'unnamed');
    const cur = await colServers.findOne({ name });
    const doc = {
        ip: clean(body.ip) || (cur && cur.ip) || '',
        port: parseInt(body.port, 10) || (cur && cur.port) || 6567,
        mode: clean(body.mode) || (cur && cur.mode) || '',
        desc: clean(body.desc) || (cur && cur.desc) || '',
        players: Math.max(0, parseInt(body.players, 10) || 0),
        lastSeen: Date.now()
    };
    await colServers.updateOne({ name }, { $set: doc }, { upsert: true });
    console.log('[register] ' + name + ' ' + (doc.ip || '?') + ':' + doc.port + ' ' + doc.players + 'p ' + doc.mode);
}

async function handleChat(body) {
    const msg = chatText(body.message);
    if (!msg) return;
    const doc = {
        server: clean(body.server, '?'),
        name: clean(body.name, '?'),
        message: msg,
        ts: Date.now()
    };
    await colMessages.insertOne(doc);
    console.log('[chat] ' + doc.server + ' / ' + doc.name + ': ' + msg);
}

async function pollLines(since) {
    const list = await colMessages.find(
        { ts: { $gt: since } },
        { projection: { _id: 0 }, sort: { ts: 1 }, limit: MAX_MESSAGES }
    ).toArray();
    return list.map(m => [clean(m.server, '?'), clean(m.name, '?'), chatText(m.message), m.ts].join('|')).join('\n');
}

async function handleSync(body) {
    const now = Date.now();
    const parsed = [];
    for (const line of String(body.players || '').split('\n')) {
        const parts = line.trim().split('|');
        const uuid = clean(parts[0]);
        if (!uuid) continue;
        const incoming = parseInt(parts[1], 10);
        parsed.push({
            uuid,
            score: Number.isFinite(incoming) ? incoming : 100,
            kicks: Math.max(0, parseInt(parts[2], 10) || 0)
        });
    }
    if (!parsed.length) {
        console.log('[sync] 0 players');
        return '';
    }
    const existing = await colScores.find(
        { uuid: { $in: parsed.map(p => p.uuid) } },
        { projection: { _id: 0 } }
    ).toArray();
    const map = new Map(existing.map(d => [d.uuid, d]));
    const ops = [];
    const out = [];
    for (const p of parsed) {
        const cur = map.get(p.uuid);
        if (cur && cur.locked) {
            ops.push({ updateOne: { filter: { uuid: p.uuid }, update: { $set: { kicks: p.kicks, updated: now } } } });
            out.push(p.uuid + '=' + cur.score);
        } else {
            ops.push({ updateOne: { filter: { uuid: p.uuid }, update: { $set: { score: p.score, kicks: p.kicks, updated: now } }, upsert: true } });
            out.push(p.uuid + '=' + p.score);
        }
    }
    await colScores.bulkWrite(ops, { ordered: false });
    console.log('[sync] ' + parsed.length + ' players');
    return out.join('\n');
}

async function handlePlugin(body, res) {
    const action = String(body.action || '');
    const secret = action === 'sync' ? TRUST_SECRET : BACKEND_SECRET;
    if (body.secret !== secret) {
        console.log('[deny] bad secret for action=' + action);
        return sendJson(res, 403, { ok: false, error: 'bad secret' });
    }
    if (!db) return sendJson(res, 503, { ok: false, error: 'db not ready' });
    switch (action) {
        case 'register':
            await handleRegister(body);
            return sendJson(res, 200, { ok: true });
        case 'list':
            return sendJson(res, 200, { ok: true, servers: await serverLines() });
        case 'chat':
            await handleChat(body);
            return sendJson(res, 200, { ok: true });
        case 'poll':
            return sendJson(res, 200, { ok: true, messages: await pollLines(parseInt(body.since, 10) || 0) });
        case 'sync':
            return sendJson(res, 200, { ok: true, scores: await handleSync(body) });
        default:
            return sendJson(res, 200, { ok: false, error: 'unknown action' });
    }
}

async function apiServers(res) {
    if (!db) return sendJson(res, 503, { ok: false, error: 'db not ready' });
    const now = Date.now();
    const list = await colServers.find({}, { projection: { _id: 0 } }).toArray();
    sendJson(res, 200, { ok: true, servers: sortServers(list, now).map(s => ({ ...s, online: isOnline(s, now) })) });
}

async function apiScores(res) {
    if (!db) return sendJson(res, 503, { ok: false, error: 'db not ready' });
    const list = await colScores.find({}, { projection: { _id: 0 } }).limit(2000).toArray();
    list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    sendJson(res, 200, { ok: true, scores: list });
}

async function adminScore(body, res) {
    if (body.secret !== TRUST_SECRET) return sendJson(res, 403, { ok: false, error: 'bad secret' });
    if (!db) return sendJson(res, 503, { ok: false, error: 'db not ready' });
    const uuid = clean(body.uuid);
    const score = parseInt(body.score, 10);
    if (!uuid || !Number.isFinite(score)) return sendJson(res, 400, { ok: false, error: 'uuid and score required' });
    const value = Math.max(0, Math.min(100, score));
    await colScores.updateOne(
        { uuid },
        { $set: { score: value, locked: true, updated: Date.now() }, $setOnInsert: { kicks: 0 } },
        { upsert: true }
    );
    console.log('[admin] set score ' + uuid + '=' + value + ' (locked)');
    sendJson(res, 200, { ok: true, uuid, score: value, locked: true });
}

async function adminUnlock(body, res) {
    if (body.secret !== TRUST_SECRET) return sendJson(res, 403, { ok: false, error: 'bad secret' });
    if (!db) return sendJson(res, 503, { ok: false, error: 'db not ready' });
    const uuid = clean(body.uuid);
    if (!uuid) return sendJson(res, 400, { ok: false, error: 'uuid required' });
    const r = await colScores.updateOne({ uuid }, { $set: { locked: false, updated: Date.now() } });
    if (!r.matchedCount) return sendJson(res, 404, { ok: false, error: 'uuid not found' });
    console.log('[admin] unlocked ' + uuid);
    sendJson(res, 200, { ok: true, uuid, locked: false });
}

function sendJson(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(JSON.stringify(obj));
}

function dashboard() {
    return '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>CRABOR Backend</title><style>'
        + 'body{background:#16100f;color:#f6e7d8;font-family:Segoe UI,Arial,sans-serif;margin:0;padding:24px}'
        + 'h1{color:#d4635f;margin:0 0 4px;font-size:22px}'
        + '.sub{color:#c9a79f;font-size:13px;margin-bottom:20px}'
        + 'h2{color:#d4635f;font-size:16px;margin:24px 0 8px}'
        + 'table{width:100%;border-collapse:collapse;font-size:14px}'
        + 'th{text-align:left;color:#c9a79f;font-weight:600;padding:6px 10px;border-bottom:1px solid #3a2c2a}'
        + 'td{padding:7px 10px;border-bottom:1px solid #241a18}'
        + '.on{color:#8fc07a}.off{color:#e0453c}'
        + '.dim{color:#c9a79f}'
        + 'input,button{background:#241a18;color:#f6e7d8;border:1px solid #3a2c2a;border-radius:6px;padding:7px 9px;font-size:13px}'
        + 'button{background:#d4635f;border:0;color:#16100f;font-weight:700;cursor:pointer}'
        + '.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}'
        + '</style></head><body>'
        + '<h1>CRABOR Backend <span id="db" class="off" style="font-size:13px">&#9679;</span></h1>'
        + '<div class="sub">MongoDB &middot; tu dong dong bo server &middot; cap nhat moi 8 giay &middot; <span id="clock"></span></div>'
        + '<h2>Server dang ky</h2><table><thead><tr><th></th><th>Ten</th><th>IP:Port</th><th>Mode</th><th>Players</th><th>Map</th><th>Lan cuoi</th></tr></thead><tbody id="sv"></tbody></table>'
        + '<h2>TrustScore</h2><div class="row" style="margin-bottom:10px">'
        + '<input id="uuid" placeholder="uuid" size="34"><input id="score" placeholder="score 0-100" size="12">'
        + '<input id="secret" type="password" placeholder="trust secret" size="18"><button onclick="setScore()">Dat diem</button>'
        + '<button style="background:#3a2c2a;color:#f6e7d8" onclick="unlock()">Mo khoa uuid</button></div>'
        + '<table><thead><tr><th>UUID</th><th>Score</th><th>Kicks</th><th>Khoa web</th><th>Cap nhat</th></tr></thead><tbody id="sc"></tbody></table>'
        + '<script>'
        + 'function ago(t){if(!t)return "-";var s=Math.floor((Date.now()-t)/1000);if(s<60)return s+"s";if(s<3600)return Math.floor(s/60)+"m";return Math.floor(s/3600)+"h"}'
        + 'function refresh(){'
        + 'fetch("/health").then(r=>r.json()).then(j=>{document.getElementById("db").className=j.mongo?"on":"off"}).catch(()=>{});'
        + 'fetch("/api/servers").then(r=>r.json()).then(j=>{'
        + 'document.getElementById("sv").innerHTML=(j.servers||[]).map(s=>'
        + '"<tr><td>"+(s.online?"<span class=on>&#9679;</span>":"<span class=off>&#9679;</span>")+"</td><td>"+s.name+"</td><td class=dim>"+(s.ip||"?")+":"+s.port+"</td><td>"+(s.mode||"-")+"</td><td>"+(s.players||0)+"</td><td class=dim>"+(s.desc||"-")+"</td><td class=dim>"+ago(s.lastSeen)+"</td></tr>").join("")||"<tr><td colspan=7 class=dim>chua co server nao</td></tr>";'
        + '}).catch(()=>{});'
        + 'fetch("/api/scores").then(r=>r.json()).then(j=>{'
        + 'document.getElementById("sc").innerHTML=(j.scores||[]).slice(0,100).map(p=>'
        + '"<tr><td class=dim>"+p.uuid+"</td><td>"+p.score+"</td><td>"+p.kicks+"</td><td>"+(p.locked?"<span class=on>co</span>":"-")+"</td><td class=dim>"+ago(p.updated)+"</td></tr>").join("")||"<tr><td colspan=5 class=dim>chua co du lieu</td></tr>";'
        + '}).catch(()=>{});'
        + 'document.getElementById("clock").textContent=new Date().toLocaleTimeString();'
        + '}'
        + 'function post(url,body){return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json()).then(j=>{alert(j.ok?"OK":"Loi: "+(j.error||"?"));refresh()})}'
        + 'function setScore(){post("/api/score",{uuid:document.getElementById("uuid").value.trim(),score:document.getElementById("score").value,secret:document.getElementById("secret").value})}'
        + 'function unlock(){post("/api/score/unlock",{uuid:document.getElementById("uuid").value.trim(),secret:document.getElementById("secret").value})}'
        + 'refresh();setInterval(refresh,8000);'
        + '</script></body></html>';
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        });
        return res.end();
    }
    if (req.method === 'GET') {
        if (url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(dashboard());
        }
        if (url === '/health') {
            return sendJson(res, 200, { ok: true, mongo: !!db, uptime: Math.floor(process.uptime()) });
        }
        if (url === '/api/servers') {
            return apiServers(res).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
        }
        if (url === '/api/scores') {
            return apiScores(res).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
        }
        return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    if (req.method === 'POST') {
        let size = 0;
        let bad = false;
        const chunks = [];
        req.on('data', c => {
            if (bad) return;
            size += c.length;
            if (size > BODY_LIMIT) {
                bad = true;
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (bad) return;
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch (e) {
                return sendJson(res, 400, { ok: false, error: 'bad json' });
            }
            if (typeof body !== 'object' || body === null) body = {};
            const handler = url === '/api/score' ? adminScore
                : url === '/api/score/unlock' ? adminUnlock
                : handlePlugin;
            handler(body, res).catch(e => {
                console.log('[error] ' + e.message);
                sendJson(res, 500, { ok: false, error: 'internal' });
            });
        });
        req.on('error', () => {});
        return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
});

setInterval(() => pruneOldServers().catch(() => {}), 60 * 60 * 1000);

server.listen(PORT, HOST, () => {
    console.log('CRAB backend listening on http://' + HOST + ':' + PORT);
    connectMongo();
});
