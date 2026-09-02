# Home PC Remote

iPhone-ról vezérelt kapcsolópult az otthoni Windows géphez: ellenőrzi, hogy online-e,
mappát hoz létre/nyit meg VS Code-ban (automatikusan megbízhatóként, Claude Code
panellel és Remote Control-lal automatikusan aktiválva), majd le is tudja állítani
a gépet. Minden a Tailscale-en belül fut, nyilvános internetre semmi nem kerül ki.

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
  - POST /api/shutdown                proxyzva
        │  plain HTTP a tailneten belül (a WireGuard már titkosít)
        ▼
Windows PC — windows-agent/agent.py (Task Scheduler indítja "At log on"-nal)
  - listázza/létrehozza a projekt mappákat
  - `code --disable-workspace-trust [mappa]` — VS Code indítás, trust-dialógus nélkül
  - `shutdown /s /t <mp>` — gép leállítása
        │  a VS Code-on belül (nem az agentben) fut:
        ▼
VS Code — auto-run-command extension + Claude Code extension
  - VS Code minden megnyitáskor lefuttatja a `claude-vscode.sidebar.open`
    parancsot (auto-run-command.rules a user settings.json-ban)
  - a Claude Code extension `remoteControlAtStartup: true` beállítással minden
    új interaktív session-t automatikusan Remote Control-ba kapcsol
  - eredmény: a mappa megnyitása minden emberi beavatkozás nélkül végigviszi
    a "VS Code megnyílik → Claude panel megnyílik → Remote Control aktív"
    láncot, és a session megjelenik a claude.ai/code-on
```

## Miért nincs itt AnyDesk / manuális trust-kattintás?

Az első tervben a mappa-trust és a Claude bejelentkezés szándékosan manuális lépés lett
volna (AnyDesk-kel ránézve a képernyőre). Ezt a felhasználó elvetette: minden lépés
gombbal, szkriptelve fusson, VS Code-on belüli, valódi Claude Code session-nel
(nem egy külön CLI-alapú terminál-session-nel).

- **Trust**: a `code` mindig a hivatalos, dokumentált `--disable-workspace-trust`
  kapcsolóval indul, ami kikapcsolja a trust-dialógust az adott ablakra. Ez nem trükk —
  pontosan erre a célra (automatizált/scriptelt VS Code indítás) létezik.
- **Claude panel + Remote Control automatikus indítása**: a VS Code Claude Code
  extension-nek nincs parancssori/programozott módja arra, hogy egy külső szkript
  adott mappával *és* Remote Control-lal nyisson meg egy tabot — ezt VS Code-on belül,
  egyszeri beállítással oldottuk meg:
  1. Az [auto-run-command](https://marketplace.visualstudio.com/items?itemName=gabrielgrinberg.auto-run-command)
     extension VS Code minden indításakor lefuttatja a `claude-vscode.sidebar.open`
     parancsot (`auto-run-command.rules` a VS Code user `settings.json`-jában).
  2. A Claude Code `remoteControlAtStartup: true` beállítás (`~/.claude/settings.json`)
     miatt minden így induló session automatikusan csatlakozik Remote Control-hoz.
  3. A `claude-vscode.sidebar.open` a workspace-hez tartozó legutóbbi session-t nyitja
     meg (vagy újat indít, ha még nem volt), tehát ismételt megnyitáskor a korábbi
     beszélgetés folytatódik, nem indul mindig újra.

  Ez a gyakorlatban **nem igényel bejelentkezést**, mert a Claude Code egyszeri
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

Ha a tárolt Claude-hitelesítés mégis lejár (ritka), a VS Code Claude panel jelzi majd,
hogy bejelentkezést kér — ilyenkor (és csak ilyenkor) kell egyszer fizikailag vagy egy
távoli asztali programmal (pl. AnyDesk, ha van telepítve unattended access-szel)
ránézni a gépre és újra bejelentkezni.

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
   a PATH-on), a [Claude Code CLI-t](https://code.claude.com/docs/en/setup) és a
   VS Code [Claude Code extension-t](https://code.claude.com/docs/en/vs-code), majd
   fuss le egyszer interaktívan `claude login`-t, hogy a hitelesítés elmentődjön.
5. Telepítsd az [auto-run-command](https://marketplace.visualstudio.com/items?itemName=gabrielgrinberg.auto-run-command)
   VS Code extension-t (`code --install-extension gabrielgrinberg.auto-run-command`),
   majd a VS Code user `settings.json`-jába (`Ctrl+Shift+P` → *Open User Settings (JSON)*)
   add hozzá:
   ```json
   "auto-run-command.rules": [
     { "condition": "always", "command": "claude-vscode.sidebar.open" }
   ]
   ```
6. A Claude Code `~/.claude/settings.json`-jába add hozzá (vagy `/config` a CLI-ben →
   *Enable Remote Control for all sessions*):
   ```json
   "remoteControlAtStartup": true
   ```
   Ez a két beállítás együtt biztosítja, hogy VS Code bármelyik mappával való
   megnyitása automatikusan megnyissa a Claude panelt és aktiválja a Remote Control-t.
7. Klónozd/másold ezt a repót (vagy csak a `remote-pc/windows-agent/` mappát) a gépre,
   pl. `C:\remote-pc\windows-agent`.
8. Másold `config.example.json` → `config.json`, töltsd ki:
   - `auth_token`: hosszú, véletlen string (egyezzen a Pi `windows_agent_token`-jével)
   - `projects_root`: hova kerüljenek az új projekt mappák (ez csak a kezdeti érték —
     a telefonos Beállítások panelről bármikor átírható; az aktuális érték a
     `windows-agent/runtime-config.json`-ban perzisztálódik, agent-újraindítást is túlél)
   - `code_command`: ha `code` npm-mel vagy a felhasználói telepítőjével került fel,
     gyakran csak a *felhasználói* PATH-on van, nem a gépszintűn, amit a Task
     Scheduler-ből induló folyamat örököl — ha `vscode/open` `WinError 2`-t ad, cseréld
     abszolút elérési útra, pl.
     `C:\\Users\\<name>\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd`
9. Regisztráld az agentet: nyiss egy admin PowerShell-t a `windows-agent` mappában, és
   futtasd: `powershell -ExecutionPolicy Bypass -File register-task.ps1`
10. Nyiss tűzfal-szabályt, ami csak a Tailscale tartományból engedi be az agent portját:
    ```powershell
    New-NetFirewallRule -DisplayName "RemotePCAgent" -Direction Inbound -Protocol TCP `
      -LocalPort 8788 -RemoteAddress 100.64.0.0/10 -Action Allow
    ```
11. Jelentkezz ki és be egyszer, hogy a Task Scheduler-bejegyzés elinduljon, és
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

A négy kártya bármelyik gombja bármikor megnyomható — nincs automatikus láncolás.
Tipikus menet:

1. Kapcsold be fizikailag a gépet és jelentkezz be → **Gép állapota** kártyán
   **Online ellenőrzés**.
2. **Új projekt mappa létrehozása** (vagy válassz meglévőt a felső legördülőből).
3. **Mappa megnyitása** — ez egy lépésben elindítja VS Code-ot, megnyitja a Claude
   Code panelt, és aktiválja a Remote Control-t.
4. Nyisd meg a claude.ai/code appot / weboldalt a telefonon, és csatlakozz a futó
   session-höz (a mappa nevével auto-generált néven, vagy a legutóbbi beszélgetés
   címével, ha már dolgoztál korábban ebben a mappában).
5. Ha végeztél: **Számítógép leállítása** (megerősítést kér), majd fizikailag
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
- A `claude-vscode.sidebar.open` a workspace-hez tartozó *legutóbbi* session-t nyitja
  meg — ha egy adott mappában több párhuzamos beszélgetést szeretnél, azt VS Code-ban
  kell kézzel indítanod (**Open in New Tab**), az automatika csak az elsőt intézi.
- Az auto-run-command extension és a `remoteControlAtStartup` beállítás a *gépre*
  vonatkozik, nem projektenkénti — minden VS Code-ablak (nem csak a windows-agent
  által nyitottak) automatikusan megnyitja a Claude panelt és Remote Control-ba
  kapcsol. Ha ez nem kívánt egy adott munkafolyamatnál, a `/config` paranccsal
  (vagy a `remoteControlAtStartup` kikapcsolásával) egyedi session-önként
  felülírható.
- A rendszer élesben tesztelve és ellenőrizve lett a célgépen (Windows PC + Raspberry
  Pi + iPhone), végpontig: online-ellenőrzés, projekt mappa létrehozás/megnyitás,
  automatikus Claude panel + Remote Control aktiválás, és leállítás egyaránt működik.
