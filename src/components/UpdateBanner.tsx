"use client";

import { useEffect, useState } from "react";

export default function UpdateBanner() {
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!window.electronAPI) return;

    // Verificação manual no GitHub (já que a versão Portable não tem Auto-Updater nativo)
    const checkGitHub = async () => {
      try {
        const currentVersion = await window.electronAPI.getVersion();
        const res = await fetch("https://api.github.com/repos/OZalo/compartilharteladesktop/releases/latest");
        const data = await res.json();
        const latestTag = data.tag_name;
        
        if (latestTag) {
          const latestVersion = latestTag.replace(/^v/, "");
          // Compara de forma simples
          if (latestVersion !== currentVersion && latestVersion > currentVersion) {
             setNewVersion(latestVersion);
          }
        }
      } catch (err) {}
    };
    
    checkGitHub();
    const interval = setInterval(checkGitHub, 1000 * 60 * 30); // 30 min
    return () => clearInterval(interval);
  }, []);

  if (!newVersion) return null;

  return (
    <div className="update-banner">
      <div className="update-banner-text">
        Nova versão <strong>v{newVersion}</strong> disponível!
      </div>
      <button 
        className="btn btn-primary btn-sm" 
        onClick={() => window.electronAPI.openExternal("https://github.com/OZalo/compartilharteladesktop/releases/latest")}
      >
        Baixar no GitHub
      </button>
    </div>
  );
}
