import { t } from "@/lib/i18n";

/** The one marker for "this build is a pre-release", shared by the update pill, the settings
 *  update block and the map list's release history. */
export function PrereleasePill() {
	return <span className="prerelease-pill">{t("pre-release")}</span>;
}
