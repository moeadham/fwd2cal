import * as fs from "fs";
import * as path from "path";
import type {Response} from "express";

export {handleAdminOrganizeRequest} from "./adminOrganize";

/** Serves the admin organize form with the static CSS injected inline. */
export function serveAdminForm(res: Response): void {
  const htmlPath = path.join(__dirname, "templates/adminForm.html");
  const cssPath = path.join(__dirname, "templates/adminForm.css");
  const html = fs.readFileSync(htmlPath, "utf8");
  const styles = fs.readFileSync(cssPath, "utf8");
  res.set("Content-Type", "text/html");
  res.status(200).send(html.replace("%STYLES%", styles));
}
