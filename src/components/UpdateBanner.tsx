"use client";

import { useEffect, useState } from "react";

export default function UpdateBanner() {
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onUpdateAvailable((v) => { setNewVersion(v); setErrorMsg(null); });
    window.electronAPI.onUpdateProgress((p) => setProgress(p));
    window.electronAPI.onUpdateDownloaded(() => { setProgress(null); setReady(true); });
    if (window.electronAPI.onUpdateError) {
      window.electronAPI.onUpdateError((err) => {
        setErrorMsg("Erro ao baixar. Baixe manualmente no GitHub.");
        console.error(err);
      });
    }
  }, []);

  if (!newVersion) return null;

  return (
    <div className="update-banner">
      {errorMsg ? (
        <div className="update-banner-text" style={{ color: "var(--color-danger)" }}>
          {errorMsg}
        </div>
      ) : ready ? (
        <>
          <div className="update-banner-text">
            <strong>v{newVersion}</strong> pronta para instalar!
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.installUpdate()}>
            Reiniciar e Atualizar
          </button>
        </>
      ) : progress !== null ? (
        <>
          <div style={{ flex: 1 }}>
            <div className="update-banner-text">
              Baixando <strong>v{newVersion}</strong>...
            </div>
            <div className="update-progress" style={{ marginTop: 8 }}>
              <div className="update-progress-bar" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <span style={{ fontSize: "0.82rem", color: "var(--color-text-muted)" }}>{progress}%</span>
        </>
      ) : (
        <div className="update-banner-text">
          Nova versão <strong>v{newVersion}</strong> disponível. Baixando...
        </div>
      )}
    </div>
  );
}
