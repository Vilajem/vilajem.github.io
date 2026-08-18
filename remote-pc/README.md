# Home PC Remote

iPhone-ról vezérelt kapcsolópult az otthoni Windows géphez: felébreszti, elindítja
VS Code-ot, mappát hoz létre/nyit meg (automatikusan megbízhatóként), elindítja a
Claude Code-ot és bekapcsolja a `/remote-control`-t, majd le is tudja állítani a gépet.
Minden a Tailscale-en belül fut, nyilvános internetre semmi nem kerül ki.

## Architektúra

```
iPhone (Safari, Home Screen-re rakva)
        │  HTTPS (tailscale serve terminálja a TLS-t)
        ▼
Raspberry Pi — pi-server/server.py (mindig fut, systemd)
  - kiszolgálja ezt a weblapot (public/)
  - POST /api/wake                    Wake-on-LAN a Windows gép MAC-jére
  - GET  /api/status                  windows agent elérhető-e
  - GET/POST /api/projects            proxyzva a Windows agent felé
  - POST /api/vscode/open             proxyzva
  - POST /api/claude/start            proxyzva
  - POST /api/claude/remote-control   proxyzva
  - GET  /api/claude/output           proxyzva
  - GET  /api/claude-status           proxyzva
  - POST /api/shutdown                proxyzva
        │  plain HTTP a tailneten belül (a WireGuard már titkosít)
        ▼
Windows PC — windows-agent/agent.py (Task Scheduler indítja "At log on"-nal)
  - listázza/létrehozza a projekt mappákat
  - `code --disable-workspace-trust [mappa]` — VS Code indítás, trust-dialógus nélkül
  - `claude` subprocess indítása a mappában, majd `/remote-control` küldése a stdin-re
  - `shutdown /s /t <mp>` — gép leállítása
```

## Miért nincs itt AnyDesk / manuális trust-kattintás?

Az első tervben a mappa-trust és a Claude bejelentkezés szándékosan manuális lépés lett
volna (AnyDesk-kel ránézve a képernyőre). Ezt a felhasználó elvetette: minden lépés
gombbal, szkriptelve fusson. Ez két konkrét dolgot jelent:

- **Trust**: a `code` mindig a hivatalos, dokumentált `--disable-workspace-trust`
  kapcsolóval indul, ami kikapcsolja a trust-dialógust az adott ablakra. Ez nem trükk —
  pontosan erre a célra (automatizált/scriptelt VS Code indítás) létezik.
- **Bejelentkezés / `/remote-control`**: a Windows agent maga indítja el a `claude`
  CLI-t a kiválasztott mappában (nem a VS Code terminálján keresztül), és automatikusan
  beírja neki a `/remote-control` parancsot. Ez a gyakorlatban **nem igényel
  bejelentkezést**, mert a Claude Code CLI egyszeri interaktív `claude login` után a
  hitelesítést a `%USERPROFILE%\.claude\.credentials.json` fájlban tárolja, és azt
  minden induláskor automatikusan felhasználja.

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

1. BIOS/UEFI-ben és a hálózati kártya energiagazdálkodásában engedélyezd a
   Wake-on-LAN-t ("Wake on Magic Packet"), és jegyezd fel a hálózati kártya MAC-címét.
2. Telepítsd a [Tailscale](https://tailscale.com/) klienst, jelentkezz be, állítsd be,
   hogy automatikusan csatlakozzon induláskor.
3. Telepítsd a [VS Code](https://code.visualstudio.com/) CLI-t (`code` legyen elérhető
   a PATH-on) és a Claude Code CLI-t (`claude`), majd fuss le egyszer interaktívan
   `claude login`-t, hogy a hitelesítés elmentődjön.
4. Klónozd/másold ezt a repót (vagy csak a `remote-pc/windows-agent/` mappát) a gépre,
   pl. `C:\remote-pc\windows-agent`.
5. Másold `config.example.json` → `config.json`, töltsd ki:
   - `auth_token`: hosszú, véletlen string (egyezzen a Pi `windows_agent_token`-jével)
   - `projects_root`: hova kerüljenek az új projekt mappák (ez csak a kezdeti érték —
     a telefonos Beállítások panelről bármikor átírható; az aktuális érték a
     `windows-agent/runtime-config.json`-ban perzisztálódik, agent-újraindítást is túlél)
   - `code_command` / `claude_command`: hagyd `code`/`claude`-on, ha PATH-on vannak
6. Regisztráld az agentet: nyiss egy admin PowerShell-t a `windows-agent` mappában, és
   futtasd: `powershell -ExecutionPolicy Bypass -File register-task.ps1`
7. Nyiss tűzfal-szabályt, ami csak a Tailscale tartományból engedi be az agent portját:
   ```powershell
   New-NetFirewallRule -DisplayName "RemotePCAgent" -Direction Inbound -Protocol TCP `
     -LocalPort 8788 -RemoteAddress 100.64.0.0/10 -Action Allow
   ```
8. Jelentkezz ki és be egyszer, hogy a Task Scheduler-bejegyzés elinduljon, és
   ellenőrizd, hogy fut-e az agent (pl. Feladatkezelőben `pythonw.exe`).

### 2. Raspberry Pi előkészítése

1. Telepítsd a Tailscale-t a Pi-re is, és kapcsold be a `tailscale serve`-öt, hogy a
   pi-server HTTPS-en, a tailneten belül legyen elérhető:
   ```bash
   sudo tailscale serve https / http://127.0.0.1:8787
   ```
2. Klónozd/másold a `remote-pc/pi-server/` mappát a Pi-re, pl. `/home/pi/remote-pc/pi-server`
   (a `public/` mappának a `pi-server` mellett kell lennie, ahogy a repóban is van).
3. Másold `config.example.json` → `config.json`, töltsd ki:
   - `phone_token`: hosszú, véletlen string (ezt írod majd be a telefonos beállításokba)
   - `target_mac`, `broadcast_ip`: a Windows gép MAC-je és a helyi hálózat broadcast
     címe (pl. `192.168.1.255`)
   - `windows_agent_host`: a Windows gép Tailscale IP-je vagy MagicDNS neve
   - `windows_agent_token`: egyezzen a Windows agent `auth_token`-jével
4. Másold `remote-pc-wake.service` → `/etc/systemd/system/remote-pc-wake.service`
   (igazítsd a `User=`/`WorkingDirectory=` sorokat, ha nem `pi` a felhasználó), majd:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now remote-pc-wake.service
   ```

### 3. iPhone

1. Telepítsd a Tailscale appot, csatlakozz ugyanahhoz a tailnethez.
2. Safari-ban nyisd meg a Pi `tailscale serve`-es HTTPS címét.
3. Koppints a Megosztás → "Hozzáadás a kezdőképernyőhöz" gombra — így egy önálló
   ikonként nyílik meg, teljes képernyőn.
4. Nyisd meg a ⚙ Beállításokat a lapon, és add meg a `phone_token`-t (amit a Pi
   `config.json`-jában állítottál be).

## Használat

A hét kártya bármelyik gombja bármikor, bármilyen sorrendben megnyomható — nincs
automatikus láncolás. Tipikus menet:

1. **Gép felébresztése** → várj kb. 30-60 mp-et → **Online ellenőrzés**.
2. **Új projekt mappa létrehozása** (vagy válassz meglévőt a felső legördülőből).
3. **Mappa megnyitása VS Code-ban**.
4. **Remote Control csatlakoztatása**: Claude indítása → Remote Control aktiválása.
5. Nyisd meg a claude.ai/code appot / weboldalt a telefonon, és csatlakozz a futó
   session-höz.
6. Ha végeztél: **Számítógép leállítása** (megerősítést kér).

Az összecsukható "Aktivitás napló" mindig mutatja az utolsó ~30 API-hívást és azok
eredményét — ide érdemes nézni, ha valami nem úgy viselkedik, ahogy vártad.

## Ismert korlátok

- A Wake-on-LAN csak a hardvert kapcsolja be — ha a Windows fiók jelszóval védett és
  nincs auto-login beállítva, a gép a bejelentkezési képernyőn áll meg. A Task
  Scheduler "At log on" trigger csak tényleges interaktív bejelentkezés után indítja el
  az agentet, tehát ha nincs auto-login, az agent (és így minden gomb) csak azután
  válaszol, hogy valaki (fizikailag vagy távoli asztali programmal) bejelentkezett.
  Auto-login beállítása (`netplwiz`) ezt a lépést is kiküszöböli, de gyengíti a gép
  fizikai hozzáférés elleni védelmét — mérlegeld a saját környezetedben.
- A `%USERPROFILE%\.claude\.credentials.json` alapú bejelentkezés-heurisztika csak
  jelzés, nem garancia — ha a Claude Code egy jövőbeli verziója máshova teszi ezt a
  fájlt, a `hint` mező pontatlan lesz, de a funkcionalitás (Claude indítása,
  remote-control) ettől függetlenül működik, csak a kijelzett info lehet elavult.
- A rendszer teszteletlen a valódi hardveren (ezt a scaffoldot egy felhős sandboxban
  írtuk, ahol nincs Windows gép, Raspberry Pi vagy iPhone) — a fenti telepítési
  lépéseket végig kell menni és élesben ellenőrizni.
