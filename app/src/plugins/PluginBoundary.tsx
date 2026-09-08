import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "@/lib/util/log";

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
					<span className="plugin-boundary__label">Plugin crashed</span>
					<button
						className="plugin-boundary__retry"
						onClick={() => this.setState({ error: null })}
					>
						Retry
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
