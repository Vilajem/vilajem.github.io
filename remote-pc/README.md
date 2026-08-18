# Home PC Remote

iPhone-ról vezérelt kapcsolópult az otthoni Windows géphez: ellenőrzi, hogy online-e,
elindítja VS Code-ot, mappát hoz létre/nyit meg (automatikusan megbízhatóként),
elindítja a Claude Code-ot és bekapcsolja a `/remote-control`-t, majd le is tudja
állítani a gépet. Minden a Tailscale-en belül fut, nyilvános internetre semmi nem
kerül ki.

**Megjegyzés:** a jelenlegi célgép (ASUS ROG Ally) firmware-je nem támogatja a
hálózati Wake-on-LAN-t alvó/kikapcsolt állapotból (`powercfg /a` kimenete szerint
"Connectivity in standby is not supported"), ezért a rendszer nem tartalmaz
távoli felébresztést — a gépet fizikailag be kell kapcsolni, utána minden más
funkció (VS Code, projekt mappa, Claude, leállítás) távolról megy.

## Architektúra

```
iPhone (Safari, Home Screen-re rakva)
        │  HTTP/HTTPS a tailneten belül, /remote-pc/ path-on egy meglévő
        │  nginx mögött (vagy közvetlenül tailscale serve-vel)
        ▼
Raspberry Pi / always-on Linux gép — pi-server/server.py (Docker, host networking)
  - kiszolgálja ezt a weblapot (public/)
  - GET  /api/status                  windows agent elérhető-e
  - GET/POST /api/projects            proxyzva a Windows agent felé
  - POST /api/vscode/open             proxyzva
  - POST /api/claude/remote-control   proxyzva
  - GET  /api/claude/output           proxyzva
  - GET  /api/claude-status           proxyzva
  - POST /api/shutdown                proxyzva
        │  plain HTTP a tailneten belül (a WireGuard már titkosít)
        ▼
Windows PC — windows-agent/agent.py (Task Scheduler indítja "At log on"-nal)
  - listázza/létrehozza a projekt mappákat
  - `code --disable-workspace-trust [mappa]` — VS Code indítás, trust-dialógus nélkül
  - előzetesen elfogadja a claude CLI workspace-trust dialógusát a mappára
    (~/.claude.json-ban hasTrustDialogAccepted), majd `claude remote-control
    --name <mappa>` indítása egy lépésben
  - `shutdown /s /t <mp>` — gép leállítása
```

## Miért nincs itt AnyDesk / manuális trust-kattintás?

Az első tervben a mappa-trust és a Claude bejelentkezés szándékosan manuális lépés lett
volna (AnyDesk-kel ránézve a képernyőre). Ezt a felhasználó elvetette: minden lépés
gombbal, szkriptelve fusson. Ez két konkrét dolgot jelent:

- **Trust (VS Code)**: a `code` mindig a hivatalos, dokumentált
  `--disable-workspace-trust` kapcsolóval indul, ami kikapcsolja a trust-dialógust az
  adott ablakra. Ez nem trükk — pontosan erre a célra (automatizált/scriptelt VS Code
  indítás) létezik.
- **Trust (Claude CLI) / Remote Control**: a `claude` CLI-nek saját, VS Code-tól
  független workspace-trust dialógusa van, ami csak interaktív terminálban működik —
  a windows-agent nem fut interaktív terminálban, úgyhogy a dialógus helyett előre
  beírja a jóváhagyást a `~/.claude.json` `projects.<mappa>.hasTrustDialogAccepted`
  mezőjébe, majd egy lépésben elindítja a `claude remote-control --name <mappa>`-t
  (a hivatalos szerver-mód, ld. [Claude Code Remote Control dokumentáció](https://code.claude.com/docs/en/remote-control)).
  Ez a gyakorlatban **nem igényel bejelentkezést**, mert a Claude Code CLI egyszeri
  interaktív `claude login` után a hitelesítést a `%USERPROFILE%\.claude\.credentials.json`
  fájlban tárolja, és azt minden induláskor automatikusan felhasználja.

**Tudatos biztonsági kompromisszum**: mivel a trust-dialógus ki van kapcsolva, bárki,
aki ismeri a `phone_token`-t, tetszőleges mappában tud parancsot futtató programot
(VS Code + Claude Code) indítani rákérdezés nélkül. Emiatt:

- a `phone_token` és a `windows_agent_token` legyen hosszú, véletlenszerű string
  (pl. `openssl rand -hex 32`), és soha ne kerüljön git-be (a `.gitignore` már kizárja a
  `config.json` fájlokat);
- a Windows agent portja csak a Tailscale tartományból legyen elérhető (ld. lentebb a
  tűzfal-szabályt);
- a Pi-n a `tailscale serve` biztosítja, hogy a weblap/API kizárólag a saját
  tailneteden belülről érhető el (nincs Funnel, nincs nyilvános port).

Ha a tárolt Claude-hitelesítés mégis lejár (ritka), a `remote-control` kártya kimenet-
panelje szövegként mutatja majd, hogy bejelentkezést kér — ilyenkor (és csak ilyenkor)
kell egyszer fizikailag vagy egy távoli asztali programmal (pl. AnyDesk, ha van
telepítve unattended access-szel) ránézni a gépre és újra bejelentkezni.

## Telepítés

### 1. Windows PC előkészítése

1. Ellenőrizd `powercfg /a`-val, hogy a gép támogatja-e a hálózati Wake-on-LAN-t
   (ha a "Standby (S0 Low Power Idle) Network Connected" sor szerepel a támogatott
   listában, van esély rá — ha a "Connectivity in standby is not supported" üzenet
   jön, mint pl. ASUS ROG Ally-n, a géphez fizikai bekapcsolás szükséges, és a
   Wake funkció kihagyható). Ha támogatott, engedélyezd BIOS/UEFI-ben és a hálózati
   kártya Energiagazdálkodás fülén a "Wake on Magic Packet"-et.
2. Állítsd be az energiaterveket úgy, hogy a gép hálózati (AC) tápellátás mellett
   ne aludjon el (`powercfg` vagy Beállítások → Energiagazdálkodás), hogy az agent
   folyamatosan elérhető maradjon amíg be van kapcsolva.
3. Telepítsd a [Tailscale](https://tailscale.com/) klienst, jelentkezz be, állítsd be,
   hogy automatikusan csatlakozzon induláskor.
4. Telepítsd a [VS Code](https://code.visualstudio.com/) CLI-t (`code` legyen elérhető
   a PATH-on) és a Claude Code CLI-t (`claude`), majd fuss le egyszer interaktívan
   `claude login`-t, hogy a hitelesítés elmentődjön.
5. Klónozd/másold ezt a repót (vagy csak a `remote-pc/windows-agent/` mappát) a gépre,
   pl. `C:\remote-pc\windows-agent`.
6. Másold `config.example.json` → `config.json`, töltsd ki:
   - `auth_token`: hosszú, véletlen string (egyezzen a Pi `windows_agent_token`-jével)
   - `projects_root`: hova kerüljenek az új projekt mappák (ez csak a kezdeti érték —
     a telefonos Beállítások panelről bármikor átírható; az aktuális érték a
     `windows-agent/runtime-config.json`-ban perzisztálódik, agent-újraindítást is túlél)
   - `code_command` / `claude_command`: ha `code`/`claude` npm-mel vagy a felhasználói
     telepítőjükkel kerültek fel, gyakran csak a *felhasználói* PATH-on vannak, nem a
     gépszintűn, amit a Task Scheduler-ből induló folyamat örököl — ha `vscode/open`
     vagy `remote-control` `WinError 2`-t ad, cseréld ezeket abszolút elérési útra,
     pl. `C:\\Users\\<name>\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd`
     és `C:\\Users\\<name>\\AppData\\Roaming\\npm\\claude.cmd`
7. Regisztráld az agentet: nyiss egy admin PowerShell-t a `windows-agent` mappában, és
   futtasd: `powershell -ExecutionPolicy Bypass -File register-task.ps1`
8. Nyiss tűzfal-szabályt, ami csak a Tailscale tartományból engedi be az agent portját:
   ```powershell
   New-NetFirewallRule -DisplayName "RemotePCAgent" -Direction Inbound -Protocol TCP `
     -LocalPort 8788 -RemoteAddress 100.64.0.0/10 -Action Allow
   ```
9. Jelentkezz ki és be egyszer, hogy a Task Scheduler-bejegyzés elinduljon, és
   ellenőrizd, hogy fut-e az agent (pl. Feladatkezelőben `pythonw.exe`).

### 2. Raspberry Pi (vagy más always-on Linux gép) előkészítése

A pi-server Docker-konténerben fut, `network_mode: host`-tal (hogy elérje a
Tailscale interfészt), egy meglévő nginx mögé `/remote-pc/` path-on beillesztve —
ha a gépeden több más app is fut nginx mögött hasonló mintával, kövesd ugyanazt.

1. Telepítsd a Tailscale-t a gépre is, csatlakoztasd ugyanahhoz a tailnethez.
2. Klónozd/másold a `remote-pc/pi-server/` és `remote-pc/public/` mappákat a gépre,
   ugyanabba a szülőmappába (pl. `~/remote-pc/pi-server`, `~/remote-pc/public`) —
   a Docker build innen olvassa mindkettőt.
3. Másold `pi-server/config.example.json` → `pi-server/config.json`, töltsd ki:
   - `phone_token`: hosszú, véletlen string (ezt írod majd be a telefonos beállításokba)
   - `windows_agent_host`: a Windows gép Tailscale IP-je vagy MagicDNS neve
   - `windows_agent_token`: egyezzen a Windows agent `auth_token`-jével
4. Build és indítás:
   ```bash
   cd ~/remote-pc/pi-server
   docker compose up -d --build
   ```
5. Ha van már nginx a gépen, adj hozzá egy location blokkot a site configodhoz
   (a `/remote-pc` prefix záró `/`-je fontos, ez vágja le a prefixet, mielőtt a
   kérés a konténerbe kerül):
   ```nginx
   location /remote-pc/ {
       proxy_pass http://127.0.0.1:8787/;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   }
   ```
   majd `sudo nginx -t && sudo systemctl reload nginx`. Ha nincs még nginx-ed,
   egyszerűbb alternatíva a `tailscale serve --bg --set-path /remote-pc
   http://127.0.0.1:8787/` — ehhez előbb engedélyezni kell a Serve funkciót a
   Tailscale admin console-ban (a CLI ad egy linket, ha még nincs bekapcsolva).

### 3. iPhone

1. Telepítsd a Tailscale appot, csatlakozz ugyanahhoz a tailnethez.
2. Safari-ban nyisd meg a gép `/remote-pc/` címét a tailneten belül (pl.
   `http://<pi-magicdns-name>/remote-pc/` vagy `https://...` ha van `tailscale serve`).
3. Koppints a Megosztás → "Hozzáadás a kezdőképernyőhöz" gombra — így egy önálló
   ikonként nyílik meg, teljes képernyőn.
4. Nyisd meg a ⚙ Beállításokat a lapon, és add meg a `phone_token`-t (amit a
   `pi-server/config.json`-ban beállítottál).

## Használat

A hét kártya bármelyik gombja bármikor, bármilyen sorrendben megnyomható — nincs
automatikus láncolás. Tipikus menet:

1. Kapcsold be fizikailag a gépet és jelentkezz be → **Gép állapota** kártyán
   **Online ellenőrzés**.
2. **Új projekt mappa létrehozása** (vagy válassz meglévőt a felső legördülőből).
3. **Mappa megnyitása VS Code-ban**.
4. **Remote Control indítása** (egy gomb).
5. Nyisd meg a claude.ai/code appot / weboldalt a telefonon, és csatlakozz a futó
   session-höz.
6. Ha végeztél: **Számítógép leállítása** (megerősítést kér), majd fizikailag
   kapcsold be újra, amikor legközelebb kell.

Az összecsukható "Aktivitás napló" mindig mutatja az utolsó ~30 API-hívást és azok
eredményét — ide érdemes nézni, ha valami nem úgy viselkedik, ahogy vártad.

## Ismert korlátok

- Nincs távoli felébresztés: a célgépen (ASUS ROG Ally) a firmware nem támogatja a
  hálózati kapcsolat életben tartását alvó/kikapcsolt állapotban, ezért a gépet
  fizikailag be kell kapcsolni. Emellett a fiók jelszóval védett és nincs auto-login
  beállítva, tehát a bejelentkezési képernyőn is fizikailag be kell írni a jelszót.
  A Task Scheduler "At log on" trigger csak tényleges interaktív bejelentkezés után
  indítja el az agentet, tehát az agent (és így minden gomb) csak azután válaszol,
  hogy valaki fizikailag bejelentkezett. Auto-login beállítása (`netplwiz`) ezt a
  lépést kiküszöbölné, de gyengítené a gép fizikai hozzáférés elleni védelmét —
  ezt a felhasználó tudatosan nem kérte.
- A `%USERPROFILE%\.claude\.credentials.json` alapú bejelentkezés-heurisztika csak
  jelzés, nem garancia — ha a Claude Code egy jövőbeli verziója máshova teszi ezt a
  fájlt, a `hint` mező pontatlan lesz, de a funkcionalitás (remote-control indítása)
  ettől függetlenül működik, csak a kijelzett info lehet elavult.
- A Windows-oldali beüzemelés (Python, Claude CLI, Task Scheduler, tűzfalszabály)
  megtörtént és ellenőrzött a célgépen. A Raspberry Pi (`pi-server`) telepítése és a
  végponti (iPhone → Pi → Windows agent) forgalom élesben tesztelése még hátravan.
