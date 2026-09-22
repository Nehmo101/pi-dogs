# Lokale Modelle für Pi und pi-dogs: Ollama oder llama.cpp?

Stand: 23.09.2026, gemessen auf UWE-Nuc (i5-8259U, 32 GB RAM, RTX 3090 24 GB als Thunderbolt-eGPU, Treiber 591.86 / CUDA 13.1, Ollama 0.34.3, llama.cpp b11115, Pi 0.87.1).

## Kurzfassung

- **Warum alles auf der CPU lief:** Ollama startet beim Login über `Startup\Ollama.lnk`, etwa zwei Minuten nach dem Booten. Zu diesem Zeitpunkt war die Thunderbolt-eGPU noch nicht angemeldet. Ollama hat dann nur die CPU gefunden und bleibt dabei, bis es neu gestartet wird. **Ein Neustart von Ollama behebt das.** Danach laufen Modelle zu 100 % auf der GPU.
- **Was sinnvoller ist als Ollama:** Für pi-dogs, also mehrere Pi-Agenten gleichzeitig, ist **llama.cpp `llama-server` im Router-Modus** besser. Ollama kann die Qwen3.5/3.6-Modelle **nicht parallel bedienen**. Das steht so im eigenen Log: `model architecture does not currently support parallel requests architecture=qwen35`. Jede Anfrage wartet, bis die vorherige fertig ist. llama.cpp bearbeitet dagegen 3 bis 6 Anfragen gleichzeitig (Continuous Batching). Dazu kommt: Jeder Agent behält seinen eigenen Prompt-Cache, und Pi bindet llama.cpp direkt an (`/llama`).
- **Ollama bleibt**, für das Ollama-Cookbook, OpenCode, Embeddings (nomic-embed-text) und OCR. Beide Laufzeiten sind installiert. Große Modelle sollten aber **nicht in beiden gleichzeitig** geladen sein, denn 24 GB VRAM reichen nur für eines.

## 1. Diagnose: Ollama auf der CPU

| Befund | Beleg |
|---|---|
| Start beim Login 23:04, Boot 23:02 | `server.log`: `inference compute ... library=cpu`, `total_vram="0 B"`, `default_num_ctx=4096` |
| Auch Vulkan sah nur die Intel-iGPU | 23:04: `Vulkan0 = Intel Iris Plus 655`. Am 22.09. um 20:55, als es funktionierte, war die NVIDIA `Vulkan0` und Intel `Vulkan1`. Die eGPU war also beim Start von Ollama noch gar nicht angemeldet. |
| Das passiert regelmäßig | `server-1/3/4/5.log` (19.–22.09.): jedes Mal nur CPU. Nur ein Start (22.09. 20:55) fand CUDA. |
| Keine störenden Umgebungsvariablen | `CUDA_VISIBLE_DEVICES`, `OLLAMA_*` sind nicht gesetzt (nur Standardwerte) |
| Folgen | 4B-Modell auf der CPU, dazu nur 4k Kontext (VRAM-abhängiger Standard). Parallele Pi-Anfragen liefen in Timeouts. |

**Was ich geändert habe:** Ollama um 00:29 neu gestartet, beide Prozesse `ollama app` und `ollama`. Danach steht im Log: `library=CUDA ... NVIDIA GeForce RTX 3090 ... total="24.0 GiB"`, `default_num_ctx=32768`. `ollama ps` zeigt `100% GPU`. **An der Konfiguration ist nichts dauerhaft geändert.**

**Das Problem kommt nach jedem Neustart des Rechners wieder.** Abhilfe:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Tools\llama.cpp\ollama-gpu-check.ps1
```

Das Skript prüft im `server.log`, ob Ollama CUDA gefunden hat, und startet Ollama nur dann neu, wenn nicht (`-Force` startet immer neu). Den Autostart habe ich bewusst **nicht** verändert. Wer das automatisieren will, ersetzt `Startup\Ollama.lnk` durch einen Aufruf, der vorher auf `nvidia-smi -L` wartet. Eine Sicherung des Links sollte man vorher anlegen.

Nebenbei: Die eGPU läuft unter Last mit PCIe Gen3 x4 (Thunderbolt). Das Laden eines 17-GB-Modells dauert deshalb rund 30 s. Modellwechsel sind also teuer.

## 2. Benchmarks

Messmethode: OpenAI-kompatibles `/v1/chat/completions` mit Streaming, `temperature 0`, 300 Ausgabe-Token, gleichzeitig 1 bzw. 3 Anfragen. Gemessen wurden Token/s pro Stream, Token/s gesamt (Aggregat) und die Zeit bis zum ersten Token (TTFT). Alle Messungen liefen auf der GPU, nachdem der Fehler behoben war. Skripte: Scratchpad `bench.mjs`, `agents.mjs`, `pitest.sh`.

### Durchsatz

| Modell | Laufzeit | 1 Stream tok/s | 3 parallel: tok/s je Stream | 3 parallel: Aggregat tok/s | 3 parallel: TTFT (max) |
|---|---|---|---|---|---|
| qwen2.5-3b (identische GGUF-Datei) | Ollama | **204** | 199–205 (nacheinander) | 194 | 3,1 s |
| | llama.cpp (3 Slots) | 189 | 135 | **378** | **0,15 s** |
| qwen3.5-4b Q4_K_M | Ollama | 108 | 108–115 (nacheinander) | 106 | 7,8 s |
| | llama.cpp (3 Slots) | **141** | 90 | **247** | **0,33 s** |
| qwen3.6-27b Q4_K_M (MTP) | Ollama (nutzt MTP) | 59 | 50–64 (nacheinander) | 53 | 11,0 s |
| | llama.cpp ohne MTP | 38 | 25 | 69 | 1,0 s |
| | **llama.cpp mit MTP** (`--spec-type draft-mtp`) | **64** | 30 | **78** | **1,3 s** |

MTP bedeutet Multi-Token-Prediction: Das Modell sagt mehrere Token auf einmal voraus und prüft sie dann (Speculative Decoding). Die Trefferquote lag bei 68–73 %, im Mittel wurden etwa 3 Token pro Schritt akzeptiert.

### Lange Prompts und Agenten-Muster

| Test | Ollama | llama.cpp |
|---|---|---|
| 1 × 13k Token Prompt, Prefill | ca. 950 tok/s (TTFT 13,8 s) | 950 tok/s (ub 512), **1.115 tok/s** (ub 2048) |
| 3 × 13k Token gleichzeitig | 55 s gesamt | 61 s gesamt (Prefill ist rechenlastig, Parallelität bringt hier nichts) |
| **3 Agenten × 4 Runden**, je ca. 8k Kontext (realistisches pi-dogs-Muster) | 70 s gesamt; Runden 2–4 je Zug **10–27 s** | **52 s** gesamt; Runden 2–4 je Zug **2,5–7,6 s** |

Der letzte Test ist der entscheidende. Ollama hat für diese Modelle nur einen einzigen Slot. Drei Agenten verdrängen sich darin gegenseitig den Prompt-Cache, sodass jeder Zug erneut in der Warteschlange steht. Bei llama.cpp hat jeder Agent seinen eigenen Slot. Ab dem zweiten Zug muss nur noch die neue Nachricht verarbeitet werden. Je länger eine Sitzung läuft, desto größer wird der Abstand.

### Tool-Calling mit echtem Pi

Aufgabe: `pi -p --no-session --model <m>` soll einen Bug in `calc.py` mit dem Edit-Werkzeug beheben und `result.txt` anlegen. Geprüft wurde das Ergebnis in den Dateien, nicht nur die Antwort.

| Modell | Einzeln | 3 Pi-Agenten gleichzeitig |
|---|---|---|
| ollama/qwen3.5:4b | OK, 13 s (inkl. Laden) | – |
| ollama/qwen3.6:27b | OK, 7 s (geladen) | 3/3 OK, 15–18 s |
| llamacpp/qwen3.6-27b | OK, 7–9 s | 3/3 OK, 17 s |
| llamacpp/qwen3.5-4b | OK, 17 s (inkl. Modellwechsel) | 3/3 OK, 10–12 s |

Alle Läufe waren korrekt: Tool-Aufrufe richtig geparst, Datei korrekt bearbeitet.

### Versuch: Ollama mit `OLLAMA_NUM_PARALLEL=3`

Getestet habe ich das nur über die Prozess-Umgebung und danach zurückgesetzt. Es bringt nichts: Für `qwen35` schaltet Ollama die Parallelität ab, die Anfragen blieben nacheinander. Schlimmer noch: Während des Tests hat ein anderer Agent zusätzlich qwen3.5:4b geladen. Der VRAM stand bei 24,2 von 24,5 GB, und das 27B fiel auf **3,4 tok/s**. Windows lagert VRAM dann stillschweigend in den normalen RAM aus, `ollama ps` zeigt aber weiter „100% GPU“. Die Lehre daraus: **Nie zwei große Modelle gleichzeitig auf der Karte.**

## 3. Laufzeiten im Vergleich

| | Ollama | llama.cpp llama-server / Router | LM Studio | vLLM / SGLang | TabbyAPI (ExLlamaV2/V3) |
|---|---|---|---|---|---|
| Windows nativ | ja | ja (fertige CUDA-Builds) | ja (GUI + `lms`-CLI) | **nein**, nur WSL2/Docker | ja |
| Parallele Anfragen | ja, aber **nicht für Qwen3.5/3.6** (qwen35) | ja, Slots + Continuous Batching, gemeinsamer KV-Cache | ja (basiert auf llama.cpp) | sehr gut (PagedAttention) | ja |
| Tool-Calling OpenAI-kompatibel | ja | ja (`--jinja`, Vorlage aus dem GGUF) | ja | ja | eingeschränkt, abhängig von der Vorlage |
| Lange Kontexte | Standard 32k bei 24 GB, einstellbar | frei, KV-Cache in q8_0, pro Slot oder gemeinsam | frei | frei | frei, Q4/Q8-Cache |
| MTP / Speculative Decoding | ja (neu) | ja (`draft-mtp`, Draft-Modelle, N-Gramm) | teilweise | ja | ja (Draft-Modell) |
| Pi-Anbindung | `models.json` | **nativ** (`/login llama.cpp`, `/llama`) + `models.json` | `models.json` | `models.json` | `models.json` |
| Modellformat | eigener Store; Qwen3.5/3.6-Blobs sind **nicht** mit Standard-llama.cpp kompatibel | Standard-GGUF von Hugging Face | GGUF | safetensors / AWQ / GPTQ | EXL2/EXL3 |
| Bedienung | am einfachsten, Autostart | Start-Skript, Modelle per INI-Datei | GUI, bequem | aufwendig, WSL2 + eGPU | mittel |
| Getestet | ja | ja | nein | nein | nein |

Bewertung für diesen Rechner:
- **LM Studio** verwendet im Kern dieselbe llama.cpp-Engine, nur mit Verzögerung gegenüber den offiziellen Releases und als Closed Source. Es bietet hier nichts, was llama.cpp nicht direkt kann.
- **vLLM und SGLang** hätten den besten Durchsatz bei vielen Anfragen. Sie laufen aber nur unter Linux. WSL2 mit Thunderbolt-eGPU macht die Sache deutlich aufwendiger. Das lohnt sich erst bei 6 und mehr gleichzeitigen Agenten, und dann besser auf einem Linux-Rechner.
- **TabbyAPI** ist unter Windows schnell. Unsicher sind aber die Unterstützung der hybriden Qwen3.5/3.6-Architektur und das Tool-Calling, und das Ökosystem ist kleiner.

## 4. Empfehlung und Modell-Auswahl für pi-dogs (24 GB VRAM)

**Laufzeit:** llama.cpp-Router für pi-dogs, Ollama für alles andere.

| Rolle | Modell | Konfiguration (`models.ini`) | VRAM | Leistung |
|---|---|---|---|---|
| **Standard: Coder, Review, Recherche** | `llamacpp/qwen3.6-27b` (Qwen3.6-27B-MTP Q4_K_M) | 3 Slots, 96k Kontext gemeinsam, KV in q8_0, MTP | ca. 22–23 GB | 64 tok/s allein, ca. 30 tok/s je Agent bei 3 parallel |
| Scout (viele kurze Nachschlage-Aufgaben) | `llamacpp/qwen3.5-4b` (Q4_K_M) | 6 Slots, 128k gemeinsam | ca. 6–8 GB | 141 tok/s allein, ca. 90 bei 3 parallel |

Wichtig:
- **Beide Modelle passen nicht gleichzeitig** in 24 GB. Der Router läuft deshalb mit `--models-max 1`. Eine Anfrage an das jeweils andere Modell entlädt das aktuelle und lädt das neue, was 10–30 s dauert. Für pi-dogs bedeutet das: Innerhalb einer Phase alle lokalen Hunde auf **ein** Modell setzen. Am einfachsten ist es, für alles das 27B zu nehmen, denn mit MTP ist es schnell genug. Das 4B lohnt sich für Schwärme mit mehr als 3 gleichzeitigen, einfachen Aufgaben.
- Mehr als 3 Agenten auf dem 27B: `parallel = 4` ist möglich, der gemeinsame Kontext von 96k verteilt sich dann auf 4 Agenten. Mehr Kontext passt nicht in den VRAM.
- **Kandidat für später, nicht getestet:** Qwen3.6-35B-A3B (MoE, 3B aktive Parameter) als `unsloth/Qwen3.6-35B-A3B-MTP-GGUF`, UD-IQ4_XS (18,2 GB) oder UD-Q3_K_XL (17,2 GB). Es rechnet pro Token etwa zehnmal weniger als das 27B und dürfte bei parallelen Agenten deutlich mehr Durchsatz bringen, lässt aber weniger Platz für Kontext. Laden lässt es sich in Pi über `/llama` → *Download model…* oder per Download in `C:\Tools\llama.cpp\models`, dazu ein Eintrag in `models.ini`.

Vorschlag für die pi-dogs-Konfiguration (Rollen laut PLAN.md):

```json
{ "models": { "default": "llamacpp/qwen3.6-27b",
              "roles": { "scout": "llamacpp/qwen3.6-27b", "research": "llamacpp/qwen3.6-27b", "review": "*sonnet*" } } }
```

Für einen reinen Scout-Schwarm `llamacpp/qwen3.5-4b` verwenden. Die Ollama-Modelle (`ollama/...`) funktionieren weiterhin, laufen aber nacheinander.

## 5. Nutzung in Pi

**Server starten** (von Hand, kein Dienst, keine geplante Aufgabe):

```powershell
# versteckt im Hintergrund; -FreeOllama entlädt vorher in Ollama geladene Modelle (VRAM frei machen)
powershell -ExecutionPolicy Bypass -File C:\Tools\llama.cpp\start-llama.ps1 -Background -FreeOllama
# im Vordergrund (Log im Fenster):
powershell -ExecutionPolicy Bypass -File C:\Tools\llama.cpp\start-llama.ps1
# beenden (beendet nur den eigenen llama-server, nicht den von Ollama):
powershell -ExecutionPolicy Bypass -File C:\Tools\llama.cpp\start-llama.ps1 -Stop
```

Das 27B wird beim Start geladen (`load-on-startup`). Das 4B lädt der Router automatisch, sobald eine Anfrage dafür kommt.

**In Pi, Variante A (empfohlen für pi-dogs, bereits eingerichtet):** Anbieter `llamacpp` in `~/.pi/agent/models.json`.

```text
pi --model llamacpp/qwen3.6-27b
pi -p --no-session --model llamacpp/qwen3.5-4b "..."
```

**Variante B (native Pi-Integration):** In Pi `/login llama.cpp` aufrufen und die URL `http://127.0.0.1:8080` eintragen. Danach kann man mit `/llama` Modelle laden, entladen und von Hugging Face herunterladen und mit `/model` auswählen. Beide Varianten sprechen denselben Server an.

**Prüfen:** `curl http://127.0.0.1:8080/health` und `curl http://127.0.0.1:8080/models`. Das Router-Log liegt in `C:\Tools\llama.cpp\logs\`.

## 6. Was geändert wurde und wie man es zurücknimmt

| Änderung | Rücknahme |
|---|---|
| Ollama neu gestartet: 00:29 (GPU-Fix), 00:33 (Test mit `NUM_PARALLEL=3`/`FLASH_ATTENTION=1`, nur Prozess-Umgebung), 00:42 (zurück auf Standard). Laufende Ollama-Anfragen anderer Agenten wurden dabei abgebrochen. Beim Testen habe ich außerdem `llama-server.exe` über den Namen beendet. Dabei kann auch ein Runner-Prozess von Ollama getroffen worden sein. Ollama lädt ihn bei der nächsten Anfrage selbst neu. | Nichts nötig, keine dauerhafte Einstellung geändert |
| Neu: `C:\Tools\llama.cpp\` mit `bin\` (llama.cpp b11115, CUDA 12.4), `models\` (Qwen3.6-27B-MTP-Q4_K_M 17,1 GB und Qwen3.5-4B-Q4_K_M 2,7 GB, heruntergeladen; `qwen2.5-3b.gguf` ist ein Hardlink auf den Ollama-Blob und belegt keinen Platz), `models.ini`, `start-llama.ps1`, `ollama-gpu-check.ps1`, `logs\` | Ordner löschen. Den Ollama-Blob betrifft das nicht, da nur der Hardlink entfernt wird. |
| `~/.pi/agent/models.json`: neuer Anbieter `llamacpp` (qwen3.6-27b, qwen3.5-4b, je `contextWindow` 65536). Bei den bestehenden Ollama-Modellen `contextWindow: 32768` ergänzt, denn Pi nimmt sonst 128k an, während Ollama bei 32k stillschweigend abschneidet. Kodierung UTF-8 ohne BOM. | Sicherung zurückkopieren: `Copy-Item ~\.pi\agent\models.json.bak-2026-09-23 ~\.pi\agent\models.json` |
| **Nicht** geändert: Ollama-Modelle, Ollama-Autostart, Umgebungsvariablen, Dienste und geplante Aufgaben, Ollama-Cookbook, OpenCode | – |

Download insgesamt: ca. 20,5 GB (Modelle 19,85 GB + llama.cpp 0,65 GB; die ZIP-Dateien sind wieder gelöscht).
