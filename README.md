# CRABOR Backend (Node.js + MongoDB)

Backend cho plugin CRABOR: tự đồng bộ danh sách server, chat xuyên server, đồng bộ TrustScore.

## Yêu cầu
- Node.js >= 18
- MongoDB (khuyến nghị MongoDB Atlas free M0, hoặc mongod tự cài)

## Cài đặt và chạy
```
npm install
npm start
```

Cấu hình qua `.env` (gói zip có sẵn file; nếu clone từ git thì copy `.env.example` thành `.env` rồi sửa giá trị). `server.js` tự nạp `.env` khi khởi động; biến môi trường của hệ thống (ví dụ đặt trên Render) luôn được ưu tiên hơn `.env`.

## Biến môi trường
| Tên | Mặc định | Mô tả |
|---|---|---|
| PORT | 3000 | Cổng HTTP |
| HOST | 0.0.0.0 | Địa chỉ bind |
| BACKEND_SECRET | plague-network-2026 | Secret cho register/list/chat/poll, phải khớp `backendSecret` trong settings.json của plugin |
| TRUST_SECRET | trust-sync-2026 | Secret cho sync + API admin |
| OFFLINE_MS | 90000 | Quá thời gian này không nhận heartbeat thì server coi là offline |
| MONGODB_URI | mongodb://127.0.0.1:27017 | Chuỗi kết nối MongoDB (Atlas: mongodb+srv://user:pass@cluster/...) |
| MONGODB_DB | crab | Tên database |

## MongoDB Atlas
1. Tạo cluster M0 miễn phí.
2. Database Access: tạo user/password.
3. Network Access: thêm 0.0.0.0/0 (hoặc IP của nơi deploy).
4. Lấy connection string, đặt vào MONGODB_URI.

## Deploy Render
- Build command: `npm install`
- Start command: `npm start`
- Env vars: MONGODB_URI, MONGODB_DB, BACKEND_SECRET, TRUST_SECRET

## Endpoints
- `GET /` dashboard (tự cập nhật 8 giây)
- `GET /health`
- `GET /api/servers`, `GET /api/scores`
- `POST /api/score` (đặt điểm + khoá, cần TRUST_SECRET), `POST /api/score/unlock`
- `POST /` cho plugin: register / list / chat / poll / sync

## Nối plugin Mindustry
Sửa `config/mods/combinedplugin/settings.json` của server:
```
"backendUrl": "https://<backend-cua-ban>/",
"trustSyncUrl": "https://<backend-cua-ban>/",
"backendSecret": "<khớp BACKEND_SECRET>",
"trustSyncSecret": "<khớp TRUST_SECRET>"
```

## Dữ liệu trong MongoDB
- `servers`: unique theo name + ip + port, tự xoá nếu 7 ngày không heartbeat (nhiều server trùng tên vẫn hiện riêng).
- `scores`: unique theo uuid; điểm bị khoá từ dashboard sẽ không cho server ghi đè.
- `messages`: chat xuyên server, TTL 15 phút tự xoá.
