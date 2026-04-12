/** Renders the small browser response page for Drive action links. */
export function renderActionPage(
    status: "success" | "error" | "processing",
    message: string,
): string {
  const config = {
    success: {color: "#27ae60", icon: "&#10004;", title: "Done!"},
    error: {color: "#e74c3c", icon: "&#10006;", title: "Something went wrong"},
    processing: {color: "#3498db", icon: "&#9881;", title: "Working on it..."},
  }[status];
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>fwd2drive - ${config.title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; justify-content: center; align-items: center;
           min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 40px;
            max-width: 480px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .icon { font-size: 48px; color: ${config.color}; margin-bottom: 16px; }
    h1 { font-size: 24px; margin: 0 0 12px; color: #333; }
    p { font-size: 16px; color: #666; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${config.icon}</div>
    <h1>${config.title}</h1>
    <p>${message}</p>
    <p style="margin-top:24px;font-size:13px;color:#999;">You can close this tab.</p>
  </div>
</body>
</html>`;
}
