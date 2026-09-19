# Cai dat Background Tube (Docker / SoloHost)

## Cach 1 — Docker Compose (khuyen nghi)

Trong thu muc project:

```bash
docker compose build
docker compose up -d
```

Mo: http://127.0.0.1:18080

## Cach 2 — Build tay roi chay

```bash
docker build -t paf-app:background-tube .
docker run --rm -p 18080:8080 --name background-tube paf-app:background-tube
```

## Cach 3 — SoloHost

1. Nap ca thu muc project (co Dockerfile o goc), khong chi thu muc solohost.
2. De SoloHost build image `paf-app:background-tube` tu Dockerfile.
3. Khong can npm install. App khong co dependency.
4. Neu SoloHost hoi API key: do la key cua operator, khong phai cua nguoi nghe.

## Loi hay gap

- `npm ci` fail: package-lock cu lech package.json. Ban nay da dong bo lockfile, Dockerfile khong goi npm.
- `image paf-app:background-tube not found`: compose cu chi keo image, khong build. Ban nay da them `build: .`
- Bind `127.0.0.1:18080` tren mot so may SoloHost khong mo duoc tu LAN. Ban nay bind `18080:8080`.
