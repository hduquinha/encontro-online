// Configure aqui as URLs do projeto
window.FORM_CONFIG = {
  LIVE_START_AT: "2026-04-08T15:53:00-03:00",
  LIVE_TIMEZONE: "America/Sao_Paulo",
  SERVER_URL: "http://localhost:5174/save", // Usar o servidor Node local
  ONLINE_SERVER_URL: "", // Vazio = usa o mesmo domínio (relativo). Em dev local, use "http://localhost:5175"
  GAS_WEB_APP_URL: "", // Opcional: preencha após publicar o Apps Script
  SHEET_ID: "10qee1NabVgUakaZreJ9yTQ56kAz5RWk65qVo110k0Ps", // ID da sua planilha (já preenchido)

  // URL do vídeo da aula (hospede no Google Drive, YouTube não-listado, Vimeo, etc.)
  // Exemplos:
  //   Google Drive: "https://drive.google.com/file/d/SEU_ID/preview" (embed)
  //   YouTube:      "https://www.youtube.com/embed/SEU_VIDEO_ID"
  //   Vimeo:        "https://player.vimeo.com/video/SEU_VIDEO_ID"
  //   Arquivo direto: "https://seudominio.com/video.mp4"
  VIDEO_URL: "https://www.youtube.com/embed/aNqrsC6Opc0" // Vídeo no YouTube (não-listado)
};
