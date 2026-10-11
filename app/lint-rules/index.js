import domainObjects from "./domain-objects.js";
import noDuplicateCommandIcons from "./no-duplicate-command-icons.js";
import noEffectEventInMemo from "./no-effect-event-in-memo.js";
import noHandrolledDialogParts from "./no-handrolled-dialog-parts.js";
import noHandrolledWidgets from "./no-handrolled-widgets.js";
import noHandwrittenApiSurface from "./no-handwritten-api-surface.js";
import noIpcInLoop from "./no-ipc-in-loop.js";
import noLabelWrappedGroup from "./no-label-wrapped-group.js";
import noNativeDialog from "./no-native-dialog.js";
import noPrimitiveClass from "./no-primitive-class.js";
import noRedundantMutateGuard from "./no-redundant-mutate-guard.js";
import noSelectionAlias from "./no-selection-alias.js";
import noUndefinedCssClass from "./no-undefined-css-class.js";
import restrictedSyntax from "./restricted-syntax.js";

export default {
	meta: { name: "local" },
	rules: {
		"domain-objects": domainObjects,
		"no-duplicate-command-icons": noDuplicateCommandIcons,
		"no-effect-event-in-memo": noEffectEventInMemo,
		"no-handrolled-dialog-parts": noHandrolledDialogParts,
		"no-handrolled-widgets": noHandrolledWidgets,
		"no-handwritten-api-surface": noHandwrittenApiSurface,
		"no-ipc-in-loop": noIpcInLoop,
		"no-label-wrapped-group": noLabelWrappedGroup,
		"no-native-dialog": noNativeDialog,
		"no-primitive-class": noPrimitiveClass,
		"no-redundant-mutate-guard": noRedundantMutateGuard,
		"no-selection-alias": noSelectionAlias,
		"no-undefined-css-class": noUndefinedCssClass,
		"restricted-syntax": restrictedSyntax,
	},
};
