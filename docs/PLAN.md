# Plan: Interaktive Pi-Subagenten für Windows

Stand: 23.09.2026 · Status: Phase 0 abgeschlossen, Umsetzung läuft · Projektname: **pi-dogs**

---

## 1. Ziel

Der Haupt-Agent in Pi kann Subagenten starten, die **jeweils in einem eigenen Windows-Terminal-Fenster** (Pane) laufen. Der Haupt-Agent arbeitet weiter, während die Subagenten laufen, und bekommt ihr Ergebnis automatisch zurück. Das Ganze läuft **nativ unter Windows**, ohne WSL, tmux oder cmux.

Anforderungen aus der Abstimmung:

| # | Anforderung | Quelle |
|---|---|---|
| A1 | Jeder Subagent hat immer ein eigenes Fenster (Pane) | Owner, Frage 1 |
| A2 | Ein Subagent lässt sich **minimieren**. Er läuft dann weiter und bleibt **im Hauptfenster** als Ansicht sichtbar. | Owner, Frage 1 |
| A3 | Man kann in einem Subagenten-Fenster **selbst eingreifen und tippen**. Er gilt dann als „von Hand übernommen“. | Owner, Frage 2 |
| A4 | Der Haupt-Agent kann laufende Subagenten **nachsteuern** | Designgespräch (Named Pipe) |
| A5 | Die Kommunikation läuft über eine **Named Pipe**, nicht über Dateien oder MCP. Dateien gibt es nur als Absturz-Rückfall. | Designgespräch |
| A6 | Vorerst nur lokal genutzt, aber **so entwickelt, dokumentiert und getestet, als wäre es Open Source** | Owner, Frage 3 |

Nicht im Umfang (Nicht-Ziele):
- Linux- und macOS-Unterstützung in Version 1. Die Architektur hält sie aber offen (Abschnitt 5.4).
- Verteilte oder entfernte Agenten über das Netzwerk
- Eine eigene grafische Anwendung in Version 1 (siehe Abschnitt 2, Stufe 2)

---

## 2. Grundsatzfrage: normales Terminal oder etwas drumherum?

### Die Optionen

| | **Stufe 1: Windows Terminal + Pi-Erweiterung** | **Stufe 2: eigene Anwendung („Deck“)** |
|---|---|---|
| Was es ist | Man startet `pi` wie gewohnt in Windows Terminal. Die Erweiterung öffnet Panes, verbindet die Pipes und zeigt die Übersicht in Pi selbst an. | Eigenes Fenster (z. B. WPF + WebView2 + xterm.js + ConPTY, wie cmux auf dem Mac) mit Seitenleiste für die Agenten, Benachrichtigungen und echtem Minimieren in die Leiste |
| Sub-Pi-Oberfläche | originale Pi-TUI im Pane | originale Pi-TUI im eingebetteten Terminal |
| Minimieren | Pane wandert in einen „Parkplatz“-Tab; die Ansicht im Hauptfenster läuft über die Pipe (Abschnitt 6) | frei gestaltbar, weil uns das Fenster gehört |
| Aufwand | mittel | hoch, im Grunde ein eigenes Terminal-Programm |
| Risiko | Grenzen der Windows-Terminal-Befehle (Abschnitt 4) | Terminal-Emulation, Tastatur, Unicode, Updates |

### Empfehlung

**Zuerst Stufe 1 bauen und die Pipe so entwerfen, dass Stufe 2 später ohne Umbau darauf aufsetzen kann.**

Begründung:
1. Stufe 1 liefert den Großteil des Nutzens: sichtbare Fenster, Rückmeldung, Nachsteuern, Übernahme von Hand.
2. Alles, was die Stufe-2-Anwendung braucht (Liste der Agenten, Zustände, Live-Ereignisse, Nachsteuern), läuft ohnehin schon über die Pipe. Die Anwendung wäre dann nur ein weiterer Client derselben Schnittstelle.
3. Ob Stufe 2 überhaupt nötig ist, zeigt erst die Nutzung von Stufe 1. Besonders wichtig ist dabei, wie gut Minimieren in Windows Terminal funktioniert.

Am Ende von Stufe 1 hast du also **weiterhin ein normales Windows Terminal**. Um das Terminal herum gibt es nichts Neues; die Intelligenz steckt in Pi selbst.

---

## 3. Wie es sich am Ende anfühlt (Stufe 1)

### Normaler Ablauf

```
┌──────────────────────── Windows Terminal · Tab „pi“ ───────────────────────────┐
│ Haupt-Pi                                  │ ⟨scout⟩ Sub-Pi (qwen3.5:4b)        │
│                                           │ > Suche alle Aufrufe von …          │
│ > Analysiere das Repo und lass            │   bash  rg "createSurface" …        │
│   scout die Aufrufe suchen                │   …                                  │
│                                           ├─────────────────────────────────────┤
│ ● subagent(scout) gestartet               │ ⟨reviewer⟩ Sub-Pi (claude-sonnet-5) │
│ ● subagent(reviewer) gestartet            │ > Prüfe src/hub/…                    │
│                                           │   read  src/hub/registry.ts         │
│ ┌ Agenten ─────────────────────────────┐  │                                      │
│ │ ▶ scout     läuft   bash    00:42    │  │                                      │
│ │ ▶ reviewer  läuft   read    00:17    │  │                                      │
│ │ ▁ docs      minim.  write   03:10  ◉ │  │                                      │
│ └──────────────────────────────────────┘  │                                      │
│ > _                                       │                                      │
└───────────────────────────────────────────┴──────────────────────────────────────┘
```

- **Leiste „Agenten“** (Widget über dem Eingabefeld, immer sichtbar): eine Zeile pro Subagent mit Name, Zustand, aktuellem Werkzeug und Laufzeit. `◉` steht für neue, ungelesene Ausgabe bei minimierten Agenten.
- **Ende eines Subagenten:** Sein Ergebnis landet als Nachricht im Haupt-Agenten und löst einen neuen Zug aus. Das Pane schließt sich, oder bleibt je nach Einstellung offen.

### Minimieren und Spiegelansicht (A2)

- `/agent min docs`, eine Tastenkombination oder der Agent selbst verschiebt das Pane `docs` in den Tab „pi · Parkplatz“. Der Prozess läuft weiter, das Haupt-Tab bekommt den Platz zurück.
- `Strg+L` öffnet im Haupt-Pi ein **Overlay** mit der Live-Ansicht eines Agenten: fortlaufender Text, Werkzeugaufrufe, Status. Darunter liegt ein Eingabefeld für Nachsteuer-Nachrichten.

```
┌ docs · minimiert · claude-sonnet-5 · 03:10 · 12.4k Tokens ─────────────── [Esc] ┐
│ … schreibe docs/protocol.md                                                     │
│   write docs/protocol.md  ✓                                                     │
│ Ich ergänze jetzt die Beispiele für steer und done …                            │
│                                                                                  │
│ ─────────────────────────────────────────────────────────────────────────────── │
│ Nachsteuern › Beispiele bitte auf Englisch_                                      │
│ [Enter] senden  [Tab] nächster Agent  [R] wiederherstellen  [K] beenden          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- `/agent show docs` oder `[R]` im Overlay holt das Pane zurück ins Haupt-Tab.

### Von Hand übernehmen (A3)

- Du klickst in ein Subagenten-Pane und tippst. Die Erweiterung im Subagenten erkennt die Eingabe von Hand und meldet `takeover` über die Pipe.
- Die Leiste zeigt dann `✋ übernommen`. Der Haupt-Agent bekommt eine kurze Info, dass der Subagent von Hand bedient wird, und wartet nicht mehr automatisch auf ihn.
- Mit `/done` im Subagenten-Pane (oder dem Werkzeug `subagent_done`) gibst du ihn samt Ergebnis an den Haupt-Agenten zurück.

---

## 4. Rahmenbedingungen, die geprüft sind (und was noch offen ist)

### Pi (v0.87.1, in der Doku geprüft)

| Fähigkeit | API | Wofür |
|---|---|---|
| Werkzeuge für das Modell | `pi.registerTool()` | `subagent`, `subagent_steer`, … |
| Befehle | `pi.registerCommand()` | `/agents`, `/agent …` |
| CLI-Flags | `pi.registerFlag()` | Sub-Pi bekommt Pipe-Adresse und Startdatei |
| Nachrichten einspeisen | `pi.sendUserMessage()`, `pi.sendMessage()` | Ergebnis an den Haupt-Agenten, Nachsteuern im Sub-Pi |
| Dauerhafte Anzeige | `ctx.ui.setWidget()`, `setStatus()` | Leiste „Agenten“ |
| Overlay mit Fokus und `setHidden()` | `ctx.ui.custom({ overlay: true })` | Spiegelansicht |
| Lebenszyklus | `session_start`, `session_shutdown`, `agent_settled`, Ereignisse zu Nachrichten und Werkzeugen | Ressourcen öffnen und schließen, Ereignisse weiterleiten |
| Regel | Keine Prozesse oder Sockets in der Factory-Funktion starten, erst bei `session_start` | Pipe-Server erst bei Sitzungsstart |
| Pakete | `package.json` mit dem Schlüssel `"pi": { "extensions": [...] }` | Installation per `pi install` |

### Windows Terminal (`wt.exe`)

Sicher bekannt:
- `wt -w <Fenster> split-pane -V|-H --size <0..1> --title <T> -d <cwd> -- <Befehl>`
- `new-tab`, `focus-tab`, `move-focus`, `swap-pane`, Tab-Farbe (`--tabColor`)
- Ein Pane schließt sich, wenn sein Prozess endet (abhängig von `closeOnExit`).
- **Kein** Weg, von außen Text in ein Pane zu schreiben oder Inhalt auszulesen. Das übernimmt deshalb unsere Pipe.

**Wichtig für die Architektur:** Neue Panes erben die Umgebungsvariablen **von Windows Terminal, nicht vom aufrufenden Pi**. Adresse und Token der Pipe werden deshalb über eine Startdatei und ein CLI-Flag übergeben, nicht über Umgebungsvariablen.

**Offen, wird im Spike (Phase 0) geklärt:**

| Frage | Warum kritisch | Rückfall, falls nein |
|---|---|---|
| Lässt sich ein bestimmtes Pane gezielt in einen anderen Tab verschieben (`move-pane`, gezieltes `focus-pane`)? | Grundlage für Minimieren (A2) | Jeder Subagent bekommt von Anfang an einen eigenen **Tab** statt eines geteilten Panes. Minimieren heißt dann: Tab nicht im Vordergrund; die Spiegelansicht bleibt gleich. |
| Landen neue Panes zuverlässig im Fenster des Haupt-Pi, auch wenn gerade ein anderes Windows-Terminal-Fenster aktiv ist? | Panes dürfen nicht im falschen Fenster aufgehen | Das Fenster beim Start benennen (`-w pi-<hubId>`) und Pi darin starten, per Skript `pi-wt` |
| Wird der Fokus beim Teilen gestohlen? | Man tippt gerade im Haupt-Pi | Direkt danach `move-focus` zurück |
| Wie verhalten sich Tastenkombinationen, die Windows Terminal selbst belegt? | Kürzel für das Overlay | Kürzel frei konfigurierbar machen |

---

## 5. Architektur

### 5.1 Überblick

```
                         ┌──────────────── Haupt-Pi (Prozess) ─────────────────┐
                         │  Erweiterung „hub“                                  │
  Modell ── Werkzeuge ──▶│   ├─ Registry (Zustand aller Agenten)               │
                         │   ├─ Pipe-Server  \\.\pipe\pi-dogs-<hubId>           │
                         │   ├─ PaneBackend  (Windows Terminal)                │
                         │   └─ UI: Leiste + Overlay                            │
                         └───────────────▲──────────────┬───────────────────────┘
                                         │ JSONL        │ wt split-pane … node launcher.mjs <startdatei>
                     ┌───────────────────┴───┐     ┌────▼────────────────────────────┐
                     │ Sub-Pi „scout“        │     │ launcher.mjs                     │
                     │  Erweiterung „agent“  │◀────│  startet pi, hält stdio,         │
                     │   ├─ Pipe-Client      │     │  schreibt beim Ende die Exit-Datei│
                     │   ├─ Ereignisse weiter│     └─────────────────────────────────┘
                     │   ├─ erkennt Übernahme│
                     │   └─ subagent_done    │
                     └───────────────────────┘
```

### 5.2 Bausteine

| Baustein | Aufgabe |
|---|---|
| **hub** (Erweiterung im Haupt-Pi) | Werkzeuge und Befehle, Registry, Pipe-Server, UI, Überwachung. Der Hub ist in Version 1 **in Pi eingebettet**; das Protokoll erlaubt, ihn später als eigenen Prozess herauszulösen (Stufe 2, MCP-Brücke). |
| **agent** (Erweiterung im Sub-Pi) | Verbindet sich mit der Pipe, stellt sich vor (`hello`), leitet gefilterte Ereignisse weiter, nimmt `steer` und `abort` an, erkennt die Übernahme von Hand, stellt `subagent_done` bereit |
| **launcher.mjs** | Kleines Node-Skript, das im Pane läuft. Liest die Startdatei (und löscht sie), setzt die Umgebung, startet `pi` mit geerbtem Terminal, schreibt beim Ende `exit.json`. Kommt ohne PowerShell aus, bleibt also plattformneutral. |
| **PaneBackend** (Schnittstelle) | `open(spec) → paneRef`, `park(ref)`, `restore(ref)`, `focus(ref)`, `canClose`. Version 1 bringt `WindowsTerminalBackend`; später sind `TmuxBackend`, `WezTermBackend` und `DeckBackend` möglich. |
| **protocol** | Nachrichtentypen, Versionierung, JSONL-Framing (U+2028 und U+2029 **nicht** als Zeilenende werten; kein `readline`) |

### 5.3 Start eines Subagenten, Schritt für Schritt

1. Das Modell ruft `subagent({ name, task, model?, tools?, cwd?, mode? })` auf.
2. Der Hub prüft Name und Grenzen (maximale Zahl der Agenten), legt die Sitzungsdatei für den Subagenten an (Vorbild ist das Original: der Kontext des Haupt-Agenten wird optional mitgegeben) und erzeugt ein einmaliges Token.
3. Der Hub schreibt die Startdatei `%TEMP%\pi-dogs\<agentId>\launch.json` mit Pipe-Adresse, Token, Pi-Argumenten und cwd.
4. `WindowsTerminalBackend.open()` → `wt -w <fenster> split-pane -V --title "⟨scout⟩" -d <cwd> -- node launcher.mjs <launch.json>`
5. `launcher.mjs` startet `pi --session <datei> --model … -e <agent-ext> --pi-dogs-launch <launch.json>`.
6. Die Agent-Erweiterung verbindet sich bei `session_start` mit der Pipe und schickt `hello{agentId, token, pid, protocol:1}`. Der Hub prüft das Token, sonst trennt er die Verbindung.
7. Der Hub schickt `task`; die Agent-Erweiterung speist ihn mit `sendUserMessage` ein.
8. Das Werkzeug `subagent` antwortet dem Modell **sofort** (asynchron): „scout gestartet“.
9. Während der Arbeit: `event` und `status` fließen zum Hub, die Leiste und das Overlay aktualisieren sich.
10. Am Ende schickt der Agent `done{summary, usage}`. Der Hub speist das Ergebnis mit `pi.sendMessage(…, triggerTurn)` in den Haupt-Agenten ein. Das Sub-Pi beendet sich, und der Launcher schreibt `exit.json`.

### 5.4 Offen für später (deshalb die Schnittstellen)

- **Andere Plattformen:** eigenes `PaneBackend` und Pipe-Pfad (`/tmp/pi-dogs-<id>.sock`, Node `net` kann beides)
- **Stufe 2 „Deck“:** verbindet sich als Beobachter-Client mit dem Hub (Protokollrolle `viewer`)
- **MCP-Brücke:** ein kleiner MCP-Server als weiterer Hub-Client, damit auch Claude Code, Codex oder OpenCode Pi-Subagenten starten können

---

## 6. Protokoll (Version 1)

Transport: Named Pipe `\\.\pipe\pi-dogs-<hubId>`, eine JSON-Nachricht pro Zeile (LF), UTF-8. Jede Nachricht hat `v`, `type` und `agentId`; Anfragen, auf die geantwortet wird, haben zusätzlich eine `id`.

| Richtung | `type` | Inhalt | Zweck |
|---|---|---|---|
| Agent → Hub | `hello` | `token, pid, piVersion, protocol` | Anmelden; der Hub prüft das Token |
| Hub → Agent | `welcome` / `reject` | `config` | Anmeldung bestätigt oder abgelehnt |
| Hub → Agent | `task` | `text` | Erster Auftrag |
| Agent → Hub | `status` | `state, tool?, usage, model` | Zustandswechsel (höchstens ca. 4 pro Sekunde) |
| Agent → Hub | `event` | gefilterte Pi-Ereignisse: `text_delta` (gebündelt), `tool_start` / `tool_end` (Argumente gekürzt) | Spiegelansicht |
| Hub → Agent | `steer` | `text, mode: "steer" \| "followUp"` | Nachsteuern (A4) |
| Hub → Agent | `abort` | `reason` | Aktuellen Zug abbrechen |
| Hub → Agent | `shutdown` | – | Sauber beenden |
| Agent → Hub | `takeover` | – | Nutzer hat im Pane getippt (A3) |
| Agent → Hub | `done` | `summary, usage, sessionFile` | Fertig; das Ergebnis geht an den Haupt-Agenten |
| Agent → Hub | `error` | `message, fatal` | Fehler |
| beide | `ping` / `pong` | – | Verbindung prüfen (alle 5 s, Zeitüberschreitung nach 15 s) |

Zustände eines Agenten (Zustandsautomat in der Registry):

```
starting ──hello──▶ running ◀──steer── idle
    │                 │  ▲               ▲
    │ Zeitüberschr.   │  └──── Zug ──────┘
    ▼                 ├──done──▶ done
  failed ◀──Pipe-Abbruch ohne done / exit≠0
                      └──kill──▶ killed
Flags: minimized, takenOver (unabhängig vom Zustand)
```

Sicherheit: Die Pipe ist nur für den eigenen Windows-Benutzer zugänglich (Standard-ACL; im Spike prüfen). Zusätzlich braucht jede Anmeldung ein einmaliges Token pro Agent. Die Startdatei wird sofort nach dem Lesen gelöscht.

Die vollständige Spezifikation kommt nach `docs/protocol.md` (Englisch).

---

## 7. Oberfläche für Modell und Nutzer

### Werkzeuge für das Modell (bewusst wenige)

| Werkzeug | Parameter | Verhalten |
|---|---|---|
| `subagent` | `task, context (Pflicht: kurze Zusammenfassung vom Aufrufer), name?, model?, tools?, cwd?, mode: "autonomous" \| "interactive", fork?: boolean` | Startet und antwortet sofort. Das Ergebnis kommt später als Nachricht. |
| `subagent_steer` | `name, message, mode?` | Nachricht an einen laufenden Agenten |
| `subagent_list` | – | Zustand aller Agenten (kompakt) |
| `subagent_kill` | `name` | Beenden |

Im Sub-Pi: `subagent_done({ summary })`, damit sich ein autonomer Agent selbst beendet.

### Befehle und Tastenkürzel für dich

| Befehl | Wirkung |
|---|---|
| `/agents` | Overlay mit allen Agenten, Auswahl mit den Pfeiltasten |
| `/agent show <name>` / `/agent min <name>` | Pane zurückholen oder parken |
| `/agent steer <name> <text>` | Nachsteuern von Hand |
| `/agent kill <name>` | Beenden |
| `Strg+L` (konfigurierbar) | Overlay ein und aus |
| im Sub-Pi: `/done [Zusammenfassung]` | Übernahme beenden, Ergebnis an den Haupt-Agenten |

### Einstellungen (`~/.pi/agent/pi-dogs.json`)

`layout` (rechts gestapelt / Tabs), `maxAgents` (Standard 6), `maxPanesPerTab` (Standard 3, danach Tab), `closeOnDone`, `defaultModel`, `parkTabTitle`, `killChildrenOnExit` (Standard ja), `overlayShortcut`, `eventDetail` (`minimal`/`full`).

---

## 8. Fehlerfälle und Robustheit

| Fall | Verhalten |
|---|---|
| Sub-Pi stürzt ab | Pipe bricht ab und `done` fehlt → `exit.json` lesen → Zustand `failed`, Meldung an den Haupt-Agenten mit Pfad der Sitzungsdatei zum Fortsetzen |
| Sub-Pi meldet sich nicht | Zeitüberschreitung (30 s) → `failed`, Pane bleibt zur Diagnose offen |
| Nutzer schließt das Pane von Hand | wie Absturz, aber als `killed (Pane geschlossen)` gemeldet |
| Haupt-Pi beendet oder `/reload` | `session_shutdown`: je nach `killChildrenOnExit` alle Agenten beenden oder sie trennen und weiterlaufen lassen. Nach `/reload` verbinden sich laufende Agenten neu (Wiederverbindung mit Token). |
| Pi läuft nicht in Windows Terminal | Erkennung über `WT_SESSION`; klare Meldung mit Hinweis auf das Startskript `pi-wt` |
| Zu viele Ereignisse | im Agenten drosseln und bündeln; Pipe-Gegendruck beachten |
| Zwei Haupt-Pis gleichzeitig | eigene `hubId` pro Sitzung, also eigene Pipe; kein Konflikt |

---

## 9. Projektstruktur (Open-Source-tauglich)

```
pi-dogs/
├─ package.json            # Pi-Paket: "pi": { "extensions": ["src/hub/index.ts"] }
├─ README.md               # EN: Nutzen, GIF, Installation, Schnellstart
├─ LICENSE                 # MIT (Original HazAT/pi-interactive-subagents ist MIT → Hinweis in NOTICE)
├─ NOTICE                  # Herkunft übernommener Ideen oder Codeteile
├─ CHANGELOG.md
├─ CONTRIBUTING.md
├─ docs/
│  ├─ PLAN.md              # dieses Dokument (DE)
│  ├─ architecture.md      # EN
│  ├─ protocol.md          # EN, normativ
│  └─ troubleshooting.md   # EN
├─ src/
│  ├─ protocol/            # types.ts, framing.ts, version.ts
│  ├─ hub/                 # index.ts, registry.ts, server.ts, tools.ts, commands.ts, ui/{dock,overlay}.ts
│  ├─ agent/               # index.ts, client.ts, forward.ts, takeover.ts, done-tool.ts
│  ├─ backend/             # pane-backend.ts, windows-terminal.ts
│  └─ launcher/launcher.mjs
├─ bin/pi-wt.cmd           # startet Pi in einem benannten Windows-Terminal-Fenster
├─ test/
│  ├─ unit/                # Framing, Zustandsautomat, Argumente für wt
│  ├─ integration/         # Hub mit simuliertem Agenten über eine echte Pipe
│  └─ e2e/                 # echtes Pi + Ollama (qwen3.5:4b), manuelle Checkliste für Windows Terminal
└─ .github/workflows/ci.yml  # windows-latest: typecheck, lint, unit, integration
```

Sprache: Code, Kommentare und die öffentliche Doku auf **Englisch**; dieser Plan und die Notizen für den Owner auf Deutsch.

---

## 10. Phasen und Meilensteine

| Phase | Inhalt | Ergebnis / Abnahme |
|---|---|---|
| **0 · Spike** | Offene Punkte aus Abschnitt 4 praktisch klären; Mini-Prototyp: Pane öffnen, Pipe verbinden, eine Nachricht hin und zurück; Nachricht in ein laufendes Sub-Pi einspeisen; Eingabe von Hand erkennen | kurzer Spike-Bericht; **Entscheidung** geteilte Panes oder Tabs für das Minimieren |
| **1 · Kern** | Protokoll, Registry, Pipe-Server und -Client, Launcher, Windows-Terminal-Backend, `subagent`/`subagent_list`/`subagent_kill`, `subagent_done`, Ergebnis zurück an den Haupt-Agenten | Haupt-Pi startet zwei Ollama-Subagenten in Panes und bekommt beide Ergebnisse |
| **2 · Sichtbar & steuerbar** | Leiste „Agenten“, Weiterleitung der Ereignisse, Overlay mit Spiegelansicht, `subagent_steer`, Übernahme von Hand und `/done` | Nachsteuern aus Modell und Overlay funktioniert; Übernahme wird korrekt angezeigt |
| **3 · Minimieren & Layout** | Parken und Zurückholen (oder Rückfall auf Tabs), Layout-Regeln, Einstellungen, Tastenkürzel | Anforderung A2 vollständig erfüllt |
| **4 · Robustheit & Veröffentlichungsreife** | Fehlerfälle aus Abschnitt 8, Wiederverbindung nach `/reload`, Tests, CI, englische Doku, README mit GIF, Paketierung | alle Tests grün; Installation per `pi install C:\UWE\pi-dogs` |
| **5 · optional** | MCP-Brücke; Backends für tmux und WezTerm; Stufe 2 „Deck“ | je nach Bedarf |

Nach jeder Phase gibt es eine lauffähige Version mit Git-Tag. Die Tests laufen lokal mit Ollama, damit keine Cloud-Kosten entstehen.

---

## 11. Risiken

| Risiko | Wahrscheinlichkeit | Gegenmaßnahme |
|---|---|---|
| Windows Terminal kann Panes nicht gezielt verschieben | mittel | Rückfall auf Tabs (Abschnitt 4); die Spiegelansicht deckt A2 trotzdem ab |
| Pi-API ändert sich (schnelle Releases, 0.x) | hoch | Pi-Version in `peerDependencies` festlegen, dünne Adapter-Schicht, E2E-Test gegen die installierte Version |
| Übernahme von Hand schwer zu erkennen | niedrig bis mittel | Pi-Ereignis für Eingaben nutzen; im Spike prüfen |
| Tastenkürzel kollidieren mit Windows Terminal | mittel | konfigurierbar, sinnvolle Vorgabe |
| Viele Ereignisse bremsen die TUI im Haupt-Pi | niedrig | drosseln und bündeln, `eventDetail: minimal` |

---

## 12. Entscheidungen (23.09.2026)

1. **Grundsatz:** Stufe 1 zuerst, Stufe 2 „Deck“ nur bei Bedarf.
2. **Name:** `pi-dogs`
3. **Kontext:** Standard ist eine **Zusammenfassung, die das aufrufende Modell selbst schreibt**. Das Werkzeug `subagent` bekommt ein Pflichtfeld `context` (kurzer Hintergrund: Ziel, relevante Dateien, bisherige Erkenntnisse). Das kostet keinen zusätzlichen Modellaufruf und keine Wartezeit, und der Haupt-Agent kennt den Kontext am besten. `fork` (ganzes Gespräch mitgeben) bleibt als Option für Sonderfälle.
4. **Tastenkürzel:** `Strg+L` für das Overlay. Pi belegt `Strg+L` bereits mit der Modellauswahl (`app.model.select`). pi-dogs übernimmt die Taste; die Modellauswahl bleibt über `/model` erreichbar und wird in der Doku auf `Strg+Alt+L` umgelegt (per `keybindings.json`). Konfigurierbar.
5. **Beenden:** Subagenten werden mit dem Haupt-Pi beendet. Außerdem schließt sich ein Subagent, **sobald er fertig ist und sein Ergebnis gemeldet hat** (`closeOnDone: true` als Vorgabe). Seine Sitzungsdatei bleibt zum Nachlesen und Fortsetzen erhalten.
6. **Oberste Priorität: Fensteraufteilung.** Die Aufteilung auf die Bildschirmgröße muss gut aussehen, gut lesbar sein und flüssig wirken, siehe Abschnitt 13.

---

## 13. Fensteraufteilung (oberste Priorität)

### Anforderungen

- **Lesbarkeit:** Kein Pane wird so klein, dass Pi unbrauchbar wird. Richtwerte: mindestens ca. 80 Spalten × 16 Zeilen pro Subagent, mindestens ca. 100 Spalten für den Haupt-Agenten (im Spike an der echten Schriftgröße prüfen).
- **An den Bildschirm angepasst:** Die Aufteilung richtet sich nach der tatsächlichen Arbeitsfläche (Monitor, Auflösung, DPI-Skalierung, Taskleiste) und nach der Zahl der laufenden Agenten.
- **Flüssig:** kein Flackern und kein Springen. Neue und geschlossene Agenten führen zu einer ruhigen Neuaufteilung; die restlichen Fenster teilen den Platz gleichmäßig neu auf.
- **Einheitlich:** gleiche Größen innerhalb einer Spalte, klare Titel (Name, Modell), Farbe pro Agent (Tab-Farbe bzw. Titel).

### Zwei Wege, die der Spike vergleicht

| | **A: Panes in einem Windows-Terminal-Fenster** | **B: eigene Windows-Terminal-Fenster, von pi-dogs angeordnet** |
|---|---|---|
| Prinzip | `wt split-pane` mit `--size` | pro Subagent ein benanntes Fenster (`wt -w pi-dogs-<id>`), Position und Größe über die Win32-API (`SetWindowPos`), Arbeitsfläche über `MonitorFromWindow`/`GetMonitorInfo` |
| Steuerung der Größen | nur beim Teilen; ob sich bestehende Panes nachträglich per CLI ändern lassen, ist offen | vollständig: jederzeit exakte Pixel, gleichmäßige Neuaufteilung |
| Minimieren | Parkplatz-Tab (hängt an `move-pane`) | **echtes Minimieren** in die Taskleiste; Spiegelansicht im Haupt-Pi per `Strg+L` |
| Mehrere Monitore | nein | ja (z. B. Subagenten auf dem zweiten Bildschirm) |
| Aufwand | gering | zusätzlich ein kleiner Fenster-Helfer (Node-FFI oder kleine .NET-Hilfsdatei) |
| Risiko | Layout-Kontrolle reicht evtl. nicht für „sieht gut aus“ | Fenster-Zuordnung (HWND finden), DPI, Animationen |

**Entscheidung (Owner, 23.09.2026): Weg B.** pi-dogs kontrolliert damit die Größen vollständig, was die Priorität „gut aussehend und flüssig“ am besten erfüllt. Der Spike vertieft B; A wird nur zur Dokumentation kurz geprüft.

### Layout-Regeln (für beide Wege)

1. Der Haupt-Agent behält links mindestens ca. 45 % der Breite (bei einem Subagenten 50/50).
2. Die Subagenten stapeln sich rechts in einer Spalte mit gleich hohen Fenstern.
3. Passt die Mindesthöhe nicht mehr, kommt eine zweite Spalte dazu (Raster 2 × n). Bei B kann stattdessen der zweite Monitor genutzt werden.
4. Wird die Mindestgröße auch dann unterschritten, werden die ältesten Agenten automatisch minimiert (sie bleiben in der Spiegelansicht) statt alles zu verkleinern.
5. Beim Schließen eines Agenten teilen sich die übrigen den Platz neu auf.
6. Die Regeln stecken in einer reinen Funktion `computeLayout(workArea, agents, prefs) → rects`, die ohne Windows getestet werden kann (Unit-Tests mit typischen Auflösungen: 1920×1080, 2560×1440, 3440×1440, 3840×2160 bei 100/125/150 %).

---

## 14. Zusatzwünsche (23.09.2026)

### 14.1 Lustige Hundenamen

- Lässt der Aufrufer `name` weg, bekommt der Subagent einen **zufälligen, lustigen Hundenamen** (z. B. „Sir Wuffelot“, „Bello Baggins“, „Kläffi McKläffface“, „Doggo Dynamo“, „Pfotenprinz“, „Waldi Wirbelwind“).
- Namen sind innerhalb einer Sitzung eindeutig; bereits vergebene werden übersprungen. Ist die Liste erschöpft, wird eine Zahl angehängt.
- Der Name erscheint im Fenstertitel (`🐕 Bello Baggins · qwen3.5:4b`), in der Leiste „Agenten“, im Overlay und im Ergebnis an den Haupt-Agenten. Das Modell kann den Agenten über diesen Namen nachsteuern.
- Die Namensliste liegt als eigene Datei `src/hub/dog-names.ts` (≥ 60 Namen, DE und EN gemischt) und lässt sich per Einstellung `dogNames` ersetzen oder ergänzen. Namen dürfen nur Zeichen enthalten, die als Fenstertitel und Pipe-ID taugen; intern gibt es zusätzlich eine technische `agentId`.

### 14.2 Modelle für Subagenten vorgeben

Ziel: Man sagt dem Haupt-Agenten in normaler Sprache, welche Modelle die Subagenten nutzen sollen, z. B. „Nimm für Recherche qwen3.5:4b und fürs Code-Review claude-sonnet-5“.

1. **Modell pro Aufruf:** Das Werkzeug `subagent` hat den Parameter `model` (Muster wie in Pi, z. B. `ollama/qwen3.5:4b`, `*sonnet*`, optional `:<thinking>`). Der Hub prüft das Muster gegen `ctx.modelRegistry`, **bevor** ein Fenster aufgeht. Bei einem unbekannten oder nicht angemeldeten Modell kommt ein klarer Fehler mit Vorschlägen zurück.
2. **Verfügbare Modelle im Werkzeug sichtbar:** Die Beschreibung von `subagent` enthält die aktuell nutzbaren Modelle (Provider mit Login), kompakt und gekürzt. So wählt das Modell nur gültige Werte, ohne zu raten.
3. **Rollen und Voreinstellungen:** In `pi-dogs.json` lassen sich Standardmodelle hinterlegen:
   ```json
   { "models": { "default": "ollama/qwen3.5:4b",
                 "roles": { "scout": "ollama/qwen3.5:4b", "review": "*sonnet*", "research": "ollama/qwen3.6:27b" } } }
   ```
   Das Werkzeug bekommt dafür den optionalen Parameter `role`. Reihenfolge: `model` im Aufruf → `role` → `models.default` → Modell des Haupt-Agenten.
4. **Für die Sitzung per Befehl:** `/dogs model <muster>` setzt das Standardmodell für alle neuen Subagenten dieser Sitzung; `/dogs model` ohne Argument zeigt die aktuelle Belegung. Sagt man es dem Haupt-Agenten in normaler Sprache, nutzt er dafür das Werkzeug `subagent_config` (setzt dasselbe; bewusst ein kleines Werkzeug statt einer Anweisung, die im Gespräch verloren gehen kann).
5. **Anzeige:** Das Modell steht im Fenstertitel, in der Leiste und im Overlay. Im Ergebnis an den Haupt-Agenten stehen Modell und Kosten bzw. Tokens.

Umsetzung: 14.1 in Phase 1; 14.2 Punkte 1, 2 und 5 in Phase 1, Punkte 3 und 4 in Phase 2.

---

## 15. Ergebnisse Phase 0 und Plananpassungen (23.09.2026)

Details: `docs/spike/layout.md` und `docs/spike/pi-api.md`. Dieser Abschnitt hat Vorrang vor älteren Aussagen in den Abschnitten 3 bis 8.

### Fenster (Weg B bestätigt)

- **Anordnung:** Standard ist `columns`: so viele Spalten über die volle Höhe, wie mit mindestens 80 Zeichen Breite passen; danach zwei Reihen von Spalten; danach werden die ältesten Agenten minimiert. Der Haupt-Agent behält mindestens 100 Spalten. Gemessen auf 3440×1392 bei 100 %: Zeichenzelle 9×19 px, Fensterrand 36×56 px.
- **Fenstersteuerung:** koffi (Win32 per FFI) im Pi-Prozess. Nach einmaligem Laden (~25 ms) kostet jede Umordnung 2–3 ms. Kacheln mit `DeferWindowPos`, damit alle Fenster in einem Frame umspringen; nie `SWP_NOREDRAW`. Die unsichtbaren Ränder werden über `DWMWA_EXTENDED_FRAME_BOUNDS` ausgeglichen.
- **Fenster finden:** eindeutiger Tab-Titel plus `EnumWindows`, mit Zeitlimit und Wiederholung. Das Fenster startet per `--pos` gleich an seinem Zielplatz. Danach wird der Fokus mit `SetForegroundWindow` an den Haupt-Agenten zurückgegeben, beim Wiederherstellen mit `SW_SHOWNOACTIVATE`.
- **Minimieren** ist echtes Minimieren (Abschnitt 3: Parkplatz-Tab entfällt).
- Die Aussage „neue Fenster erben keine Umgebungsvariablen“ (Abschnitt 4) war falsch. Übergeben wird trotzdem über die Startdatei.

### Pi-Schnittstellen

- **Pipe-Name stabil:** `\.\pipe\pi-dogs-<PID des Haupt-Pi>`. `/reload`, `/new` und `/resume` lösen ebenfalls `session_shutdown` aus. Agenten werden deshalb **nur bei `reason === "quit"`** beendet; sonst verbinden sie sich neu. Ein Agent, dessen Pipe dauerhaft wegbricht, wertet das als „Hub weg“ und beendet sich nach einer Frist.
- **Flags** werden per `pi.getFlag()` erst in `session_start` gelesen, Schreibweise `--pi-dogs-launch=<pfad>`.
- **Auftrag nie als CLI-Argument übergeben** (sähe wie eine Eingabe von Hand aus), sondern über die Pipe (`task`) oder als vorbereitete Sitzung.
- **Einspeisen:** Im Leerlauf reicht `sendUserMessage(text)`; während eines Zuges immer mit `deliverAs: "steer" | "followUp"`.
- **Übernahme von Hand:** Ereignis `input` mit `source === "interactive"`, `!befehl` über `user_bash`.
- **Leerlauf-Signal:** `agent_settled`, nicht `agent_end`.
- **Zustand `closing`:** Nach `done` bekommt ein Agent keine Arbeit mehr; neuer Zustand in der Registry.
- **Launcher endet immer mit Code 0.** Der echte Rückgabewert steht in `exit.json`, sonst lässt Windows Terminal tote Tabs offen.
- **Beenden der Kinder:** Die Fenster sind keine Kindprozesse des Haupt-Pi. Deshalb zuerst `shutdown` über die Pipe (im `session_shutdown`-Handler abwarten, ~80 ms), danach `taskkill` auf die Pi-PID aus `hello`.
- **Strg+L:** Pi schützt die Taste als eingebautes Kürzel, eine Erweiterung kann sie nicht übernehmen. pi-dogs bringt den Befehl `/dogs setup-keys` mit: Er legt `app.model.select` auf `ctrl+alt+l` um (und `app.tree.filter.labeledOnly` passend) und fragt vorher nach. Bis dahin öffnet `Alt+M` das Overlay (Ausweichkürzel).
- **Leiste:** Text-Widgets sind auf 10 Zeilen begrenzt; bei mehr Agenten wird eine eigene Komponente verwendet. 4 Aktualisierungen pro Sekunde flackern nicht.
- **Sitzung vorbereiten:** v3-Kopf plus ein `custom_message`-Eintrag mit dem Kontext, Start per `pi --session <datei>`.
