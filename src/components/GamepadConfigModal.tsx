import { useState, useEffect, useRef } from "react";
import {
  type GamepadConfig,
  DEFAULT_GAMEPAD_CONFIG,
  loadGamepadConfig,
  saveGamepadConfig,
  sampleGamepad,
  type VirtualGamepadState,
} from "../gamepadManager";

interface GamepadConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const BUTTON_LABELS: Record<keyof GamepadConfig["buttonMap"], string> = {
  buttonA: "Botão A (Xbox) / X (PlayStation)",
  buttonB: "Botão B (Xbox) / Círculo (PlayStation)",
  buttonX: "Botão X (Xbox) / Quadrado (PlayStation)",
  buttonY: "Botão Y (Xbox) / Triângulo (PlayStation)",
  shoulderL: "LB / L1 (Ombro Esquerdo)",
  shoulderR: "RB / R1 (Ombro Direito)",
  triggerL: "LT / L2 (Gatilho Esquerdo)",
  triggerR: "RT / R2 (Gatilho Direito)",
  back: "Back / Select / Share",
  start: "Start / Options",
  thumbL: "L3 / Clique Analógico Esquerdo",
  thumbR: "R3 / Clique Analógico Direito",
  dpadUp: "D-Pad Cima",
  dpadDown: "D-Pad Baixo",
  dpadLeft: "D-Pad Esquerda",
  dpadRight: "D-Pad Direita",
  guide: "Guia / Home / Botão Xbox",
};

export default function GamepadConfigModal({ isOpen, onClose }: GamepadConfigModalProps) {
  const [config, setConfig] = useState<GamepadConfig>(DEFAULT_GAMEPAD_CONFIG);
  const [connectedPads, setConnectedPads] = useState<string[]>([]);
  const [selectedPadIndex, setSelectedPadIndex] = useState<number>(0);
  const [currentState, setCurrentState] = useState<VirtualGamepadState | null>(null);
  const [listeningForAction, setListeningForAction] = useState<keyof GamepadConfig["buttonMap"] | null>(null);
  const [savedBadge, setSavedBadge] = useState(false);

  const configRef = useRef(config);
  configRef.current = config;

  const listeningRef = useRef(listeningForAction);
  listeningRef.current = listeningForAction;

  // Carrega configuração salva
  useEffect(() => {
    if (isOpen) {
      setConfig(loadGamepadConfig());
    }
  }, [isOpen]);

  // Salva automaticamente sempre que mudar
  const updateConfig = (updater: (prev: GamepadConfig) => GamepadConfig) => {
    setConfig((prev) => {
      const next = updater(prev);
      saveGamepadConfig(next);
      setSavedBadge(true);
      setTimeout(() => setSavedBadge(false), 1500);
      return next;
    });
  };

  // Loop de monitoramento do Gamepad em tempo real
  useEffect(() => {
    if (!isOpen) return;

    let animFrame: number;

    const poll = () => {
      const gamepads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
      const padNames: string[] = [];
      let activePad: Gamepad | null = null;

      for (let i = 0; i < gamepads.length; i++) {
        const p = gamepads[i];
        if (p) {
          padNames.push(`[P${i + 1}] ${p.id}`);
          if (i === selectedPadIndex || (activePad === null && i >= 0)) {
            activePad = p;
          }
        }
      }

      setConnectedPads(padNames);

      if (activePad) {
        // Se estamos aguardando o usuário apertar um botão para remapear
        if (listeningRef.current) {
          for (let b = 0; b < activePad.buttons.length; b++) {
            const btn = activePad.buttons[b];
            if (btn && (btn.pressed || btn.value > 0.6)) {
              const action = listeningRef.current;
              updateConfig((cfg) => ({
                ...cfg,
                buttonMap: {
                  ...cfg.buttonMap,
                  [action]: b,
                },
              }));
              setListeningForAction(null);
              break;
            }
          }
        }

        const sampled = sampleGamepad(activePad, configRef.current);
        setCurrentState(sampled);
      } else {
        setCurrentState(null);
      }

      animFrame = requestAnimationFrame(poll);
    };

    animFrame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(animFrame);
  }, [isOpen, selectedPadIndex]);

  const handleResetDefaults = () => {
    if (confirm("Deseja restaurar as configurações padrão de controle?")) {
      updateConfig(() => DEFAULT_GAMEPAD_CONFIG);
    }
  };

  const handleTestVibration = () => {
    const gamepads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const pad = gamepads[selectedPadIndex] || gamepads[0];
    if (pad && (pad as any).vibrationActuator?.playEffect) {
      (pad as any).vibrationActuator.playEffect("dual-rumble", {
        startDelay: 0,
        duration: 400,
        weakMagnitude: 0.8,
        strongMagnitude: 0.8,
      });
    } else {
      alert("Seu controle ou navegador não suporta vibração direta via Gamepad API.");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="gamepad-modal-overlay animate-fade-in" onClick={onClose}>
      <div className="gamepad-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gamepad-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: "1.4rem" }}>🎮</span>
            <div>
              <h2 style={{ fontSize: "1.15rem", fontWeight: 700, margin: 0 }}>
                Configuração do Controle (Coop Remoto)
              </h2>
              <p style={{ margin: "2px 0 0", fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                Conecte seu joystick USB ou Bluetooth e jogue junto sem complicações.
              </p>
            </div>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <div className="gamepad-modal-body">
          {/* Seletor do Gamepad Físico */}
          <div className="gamepad-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <strong style={{ fontSize: "0.88rem" }}>Dispositivo Detectado</strong>
              {savedBadge && (
                <span className="badge badge-success animate-fade-in" style={{ fontSize: "0.75rem" }}>
                  ✓ Salvo
                </span>
              )}
            </div>

            {connectedPads.length === 0 ? (
              <div className="gamepad-empty-warning">
                ⚠️ Nenhum controle físico detectado. Conecte um controle ou aperte qualquer botão nele para o navegador reconhecer.
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <select
                  className="input-select"
                  value={selectedPadIndex}
                  onChange={(e) => setSelectedPadIndex(parseInt(e.target.value, 10))}
                  style={{ flex: 1, padding: "8px 12px", background: "rgba(255,255,255,0.06)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "#fff" }}
                >
                  {connectedPads.map((p, idx) => (
                    <option key={idx} value={idx}>
                      {p}
                    </option>
                  ))}
                </select>
                <button className="btn btn-secondary btn-sm" onClick={handleTestVibration} title="Testar Vibração">
                  Vibrar 📳
                </button>
              </div>
            )}
          </div>

          {/* Visualizador do Controle em Tempo Real (Tester Interativo) */}
          <div className="gamepad-card">
            <strong style={{ fontSize: "0.88rem", display: "block", marginBottom: 12 }}>
              Teste dos Botões em Tempo Real
            </strong>
            <div className="gamepad-visual-tester">
              {/* Analógico Esquerdo */}
              <div className="stick-box">
                <span className="stick-label">Analógico Esquerdo (L)</span>
                <div className="stick-circle">
                  <div className="stick-crosshair-h" />
                  <div className="stick-crosshair-v" />
                  <div
                    className="stick-thumb"
                    style={{
                      transform: `translate(${((currentState?.axisLeftX ?? 0) * 24)}px, ${(-(currentState?.axisLeftY ?? 0) * 24)}px)`,
                      background: currentState?.thumbL
                        ? "radial-gradient(circle at 35% 35%, #4ade80, #16a34a)"
                        : "radial-gradient(circle at 35% 35%, #38bdf8, #0284c7)",
                    }}
                  />
                </div>
                <span className="stick-coords">
                  X: {(currentState?.axisLeftX ?? 0).toFixed(2)} | Y: {(currentState?.axisLeftY ?? 0).toFixed(2)}
                </span>
              </div>

              {/* Botões Centrais e Triggers */}
              <div className="middle-buttons-box">
                <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 10 }}>
                  <div className={`trigger-gauge ${currentState?.triggerL && currentState.triggerL > 0.05 ? "active" : ""}`}>
                    <div className="trigger-gauge-header">
                      <span className="trigger-title">LT</span>
                      <span className="trigger-val">{Math.round((currentState?.triggerL ?? 0) * 100)}%</span>
                    </div>
                    <div className="trigger-track">
                      <div
                        className="trigger-fill"
                        style={{ width: `${Math.round((currentState?.triggerL ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className={`trigger-gauge ${currentState?.triggerR && currentState.triggerR > 0.05 ? "active" : ""}`}>
                    <div className="trigger-gauge-header">
                      <span className="trigger-title">RT</span>
                      <span className="trigger-val">{Math.round((currentState?.triggerR ?? 0) * 100)}%</span>
                    </div>
                    <div className="trigger-track">
                      <div
                        className="trigger-fill"
                        style={{ width: `${Math.round((currentState?.triggerR ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 8 }}>
                  <div className={`btn-key-badge ${currentState?.shoulderL ? "pressed" : ""}`}>LB</div>
                  <div className={`btn-key-badge ${currentState?.back ? "pressed" : ""}`}>BACK</div>
                  <div className={`btn-key-badge ${currentState?.guide ? "pressed" : ""}`}>XBOX</div>
                  <div className={`btn-key-badge ${currentState?.start ? "pressed" : ""}`}>START</div>
                  <div className={`btn-key-badge ${currentState?.shoulderR ? "pressed" : ""}`}>RB</div>
                </div>

                {/* D-Pad */}
                <div className="dpad-grid">
                  <div />
                  <div className={`dpad-btn ${currentState?.dpadUp ? "pressed" : ""}`}>▲</div>
                  <div />
                  <div className={`dpad-btn ${currentState?.dpadLeft ? "pressed" : ""}`}>◀</div>
                  <div className="dpad-center">●</div>
                  <div className={`dpad-btn ${currentState?.dpadRight ? "pressed" : ""}`}>▶</div>
                  <div />
                  <div className={`dpad-btn ${currentState?.dpadDown ? "pressed" : ""}`}>▼</div>
                  <div />
                </div>
              </div>

              {/* Botões ABXY */}
              <div className="abxy-box">
                <div className="abxy-grid">
                  <div />
                  <div className={`abxy-btn btn-y ${currentState?.buttonY ? "pressed" : ""}`}>Y</div>
                  <div />
                  <div className={`abxy-btn btn-x ${currentState?.buttonX ? "pressed" : ""}`}>X</div>
                  <div />
                  <div className={`abxy-btn btn-b ${currentState?.buttonB ? "pressed" : ""}`}>B</div>
                  <div />
                  <div className={`abxy-btn btn-a ${currentState?.buttonA ? "pressed" : ""}`}>A</div>
                  <div />
                </div>
              </div>

              {/* Analógico Direito */}
              <div className="stick-box">
                <span className="stick-label">Analógico Direito (R)</span>
                <div className="stick-circle">
                  <div className="stick-crosshair-h" />
                  <div className="stick-crosshair-v" />
                  <div
                    className="stick-thumb"
                    style={{
                      transform: `translate(${((currentState?.axisRightX ?? 0) * 24)}px, ${(-(currentState?.axisRightY ?? 0) * 24)}px)`,
                      background: currentState?.thumbR
                        ? "radial-gradient(circle at 35% 35%, #4ade80, #16a34a)"
                        : "radial-gradient(circle at 35% 35%, #38bdf8, #0284c7)",
                    }}
                  />
                </div>
                <span className="stick-coords">
                  X: {(currentState?.axisRightX ?? 0).toFixed(2)} | Y: {(currentState?.axisRightY ?? 0).toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* Ajustes de Zona Morta (Deadzone) & Eixos */}
          <div className="gamepad-card">
            <strong style={{ fontSize: "0.88rem", display: "block", marginBottom: 10 }}>
              Calibração de Zona Morta & Sensibilidade
            </strong>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", marginBottom: 4 }}>
                  <span>Zona Morta Esquerda:</span>
                  <code>{Math.round(config.deadzoneLeft * 100)}%</code>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="0.4"
                  step="0.01"
                  value={config.deadzoneLeft}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    updateConfig((c) => ({ ...c, deadzoneLeft: val }));
                  }}
                  className="volume-slider"
                  style={{ width: "100%" }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem", marginTop: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={config.invertYLeft}
                    onChange={(e) => {
                      const val = e.target.checked;
                      updateConfig((c) => ({ ...c, invertYLeft: val }));
                    }}
                  />
                  Inverter Eixo Y (Cima/Baixo)
                </label>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", marginBottom: 4 }}>
                  <span>Zona Morta Direita:</span>
                  <code>{Math.round(config.deadzoneRight * 100)}%</code>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="0.4"
                  step="0.01"
                  value={config.deadzoneRight}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    updateConfig((c) => ({ ...c, deadzoneRight: val }));
                  }}
                  className="volume-slider"
                  style={{ width: "100%" }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem", marginTop: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={config.invertYRight}
                    onChange={(e) => {
                      const val = e.target.checked;
                      updateConfig((c) => ({ ...c, invertYRight: val }));
                    }}
                  />
                  Inverter Eixo Y (Cima/Baixo)
                </label>
              </div>
            </div>
          </div>

          {/* Mapeamento e Remapeamento dos Botões */}
          <div className="gamepad-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <strong style={{ fontSize: "0.88rem" }}>Mapeamento de Botões (Xbox 360 Virtual)</strong>
              {listeningForAction && (
                <span className="badge badge-warning animate-pulse" style={{ fontSize: "0.78rem" }}>
                  Pressione o botão desejado no controle agora...
                </span>
              )}
            </div>

            <div className="mapping-table-wrap">
              <table className="mapping-table">
                <thead>
                  <tr>
                    <th>Função no Jogo</th>
                    <th style={{ width: 140 }}>Botão Físico</th>
                    <th style={{ width: 110, textAlign: "right" }}>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(BUTTON_LABELS) as (keyof GamepadConfig["buttonMap"])[]).map((action) => {
                    const btnIndex = config.buttonMap[action];
                    const isListening = listeningForAction === action;

                    return (
                      <tr key={action} className={isListening ? "row-listening" : ""}>
                        <td>
                          <span style={{ fontWeight: 500 }}>{BUTTON_LABELS[action]}</span>
                        </td>
                        <td>
                          <span className="button-index-tag">
                            {isListening ? "Aperte botão..." : `Botão ${btnIndex}`}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            className={`btn btn-xs ${isListening ? "btn-danger" : "btn-secondary"}`}
                            onClick={() => {
                              if (isListening) setListeningForAction(null);
                              else setListeningForAction(action);
                            }}
                          >
                            {isListening ? "Cancelar" : "Remapear"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="gamepad-modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={handleResetDefaults}>
            Restaurar Padrão
          </button>
          <button className="btn btn-primary btn-sm" onClick={onClose}>
            Concluir & Salvar
          </button>
        </div>
      </div>

      <style>{`
        .gamepad-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.78);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          padding: 16px;
        }
        .gamepad-modal {
          background: #11141c;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: var(--radius-lg, 16px);
          width: 100%;
          max-width: 680px;
          max-height: 88vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 20px 60px rgba(0,0,0,0.6);
          overflow: hidden;
        }
        .gamepad-modal-header {
          padding: 14px 20px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(255, 255, 255, 0.02);
        }
        .gamepad-modal-body {
          padding: 18px 20px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .gamepad-card {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: var(--radius-md, 10px);
          padding: 14px;
        }
        .gamepad-empty-warning {
          background: rgba(245, 158, 11, 0.12);
          border: 1px solid rgba(245, 158, 11, 0.3);
          color: #facc15;
          padding: 10px 14px;
          border-radius: var(--radius-sm, 6px);
          font-size: 0.82rem;
        }
        .gamepad-visual-tester {
          display: flex;
          justify-content: space-around;
          align-items: center;
          background: rgba(0,0,0,0.3);
          border-radius: var(--radius-sm, 8px);
          padding: 14px 10px;
          border: 1px solid rgba(255,255,255,0.04);
        }
        .stick-box {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .stick-label {
          font-size: 0.72rem;
          color: var(--color-text-muted);
        }
        .stick-circle {
          width: 72px;
          height: 72px;
          border-radius: 50%;
          border: 2px solid rgba(255, 255, 255, 0.28);
          background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, rgba(10, 15, 25, 0.8) 100%);
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: inset 0 2px 8px rgba(0,0,0,0.8), 0 0 10px rgba(0,0,0,0.5);
          overflow: hidden;
        }
        .stick-crosshair-h {
          position: absolute;
          width: 100%;
          height: 1px;
          background: rgba(255, 255, 255, 0.16);
          pointer-events: none;
        }
        .stick-crosshair-v {
          position: absolute;
          height: 100%;
          width: 1px;
          background: rgba(255, 255, 255, 0.16);
          pointer-events: none;
        }
        .stick-thumb {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          border: 2px solid #ffffff;
          transition: transform 0.04s linear;
          box-shadow: 0 0 12px rgba(56, 189, 248, 0.85);
          z-index: 2;
        }
        .stick-coords {
          font-size: 0.72rem;
          font-family: monospace;
          color: #e2e8f0;
          font-weight: 600;
        }
        .trigger-gauge {
          width: 84px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 8px;
          padding: 4px 8px;
          display: flex;
          flex-direction: column;
          gap: 3px;
          transition: all 0.15s ease;
        }
        .trigger-gauge.active {
          border-color: #38bdf8;
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
          background: rgba(56, 189, 248, 0.1);
        }
        .trigger-gauge-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 0.75rem;
          font-weight: 700;
        }
        .trigger-title {
          color: #94a3b8;
        }
        .trigger-gauge.active .trigger-title {
          color: #38bdf8;
        }
        .trigger-val {
          color: #fff;
          font-family: monospace;
          font-size: 0.75rem;
          font-weight: 700;
        }
        .trigger-track {
          width: 100%;
          height: 7px;
          background: rgba(0, 0, 0, 0.55);
          border-radius: 4px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .trigger-fill {
          height: 100%;
          background: linear-gradient(90deg, #0284c7, #38bdf8);
          border-radius: 4px;
          transition: width 0.04s linear;
          box-shadow: 0 0 8px #38bdf8;
        }
        .btn-key-badge {
          padding: 2px 8px;
          border-radius: 4px;
          background: rgba(255,255,255,0.08);
          font-size: 0.7rem;
          font-weight: 600;
          color: var(--color-text-muted);
          transition: all 0.1s ease;
        }
        .btn-key-badge.pressed {
          background: #38bdf8;
          color: #000;
          box-shadow: 0 0 8px #38bdf8;
        }
        .dpad-grid, .abxy-grid {
          display: grid;
          grid-template-columns: repeat(3, 22px);
          grid-template-rows: repeat(3, 22px);
          gap: 2px;
          justify-content: center;
          align-items: center;
        }
        .dpad-btn, .abxy-btn {
          width: 22px;
          height: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          background: rgba(255,255,255,0.08);
          font-size: 0.65rem;
          font-weight: 700;
          color: var(--color-text-muted);
        }
        .dpad-center {
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.5rem;
          color: rgba(255,255,255,0.2);
        }
        .abxy-btn {
          border-radius: 50%;
        }
        .btn-a.pressed { background: #22c55e; color: #000; box-shadow: 0 0 10px #22c55e; }
        .btn-b.pressed { background: #ef4444; color: #fff; box-shadow: 0 0 10px #ef4444; }
        .btn-x.pressed { background: #3b82f6; color: #fff; box-shadow: 0 0 10px #3b82f6; }
        .btn-y.pressed { background: #eab308; color: #000; box-shadow: 0 0 10px #eab308; }
        .dpad-btn.pressed { background: #38bdf8 !important; color: #000 !important; font-weight: 800; box-shadow: 0 0 12px #38bdf8 !important; }
        .mapping-table-wrap {
          max-height: 220px;
          overflow-y: auto;
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: var(--radius-sm, 6px);
        }
        .mapping-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.8rem;
        }
        .mapping-table th {
          background: rgba(255,255,255,0.04);
          padding: 8px 12px;
          text-align: left;
          color: var(--color-text-muted);
          font-size: 0.75rem;
        }
        .mapping-table td {
          padding: 6px 12px;
          border-top: 1px solid rgba(255,255,255,0.04);
        }
        .row-listening {
          background: rgba(245, 158, 11, 0.15) !important;
        }
        .button-index-tag {
          font-family: monospace;
          background: rgba(255,255,255,0.06);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.75rem;
        }
        .gamepad-modal-footer {
          padding: 12px 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(255, 255, 255, 0.02);
        }
      `}</style>
    </div>
  );
}

