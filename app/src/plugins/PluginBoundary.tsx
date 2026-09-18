import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "@/lib/util/log";
import { t } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";

interface Props {
	pluginId: string;
	children: ReactNode;
}

interface State {
	error: Error | null;
}

export class PluginBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		log.error(`plugin ${this.props.pluginId} crashed: ${error.message}`, info.componentStack);
	}

	render() {
		if (this.state.error) {
			return (
				<div className="plugin-boundary--error">
					<span className="plugin-boundary__label">{t("Plugin crashed")}</span>
					<Button small onClick={() => this.setState({ error: null })}>
						{t("Retry")}
					</Button>
				</div>
			);
		}
		return this.props.children;
	}
}
