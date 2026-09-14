import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, getKeybindings, Input, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

export function maskInputLine(line: string): string {
	const prompt = line.startsWith("> ") ? "> " : "";
	let result = "";
	for (let index = prompt.length; index < line.length;) {
		if (line.startsWith(CURSOR_MARKER, index)) {
			result += CURSOR_MARKER;
			index += CURSOR_MARKER.length;
			continue;
		}
		if (line[index] === "\x1b") {
			const ansi = line.slice(index).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/)?.[0];
			if (ansi) {
				result += ansi;
				index += ansi.length;
				continue;
			}
		}
		const character = line[index++];
		result += /\s/u.test(character) ? character : "*";
	}
	return prompt + result;
}

class MaskedInput extends Input {
	override render(width: number): string[] {
		const terminalWidth = process.stdout.columns;
		const safeWidth = Math.max(1, Number.isFinite(terminalWidth) ? Math.min(width, terminalWidth) : width);
		return super.render(safeWidth).map((line) => truncateToWidth(maskInputLine(line), safeWidth, "", false));
	}
}

export class SecretInputDialog extends Container {
	private readonly input = new MaskedInput();
	private _focused = false;

	constructor(done: (value: string | undefined) => void, title: string, helpText: string, border: (text: string) => string) {
		super();
		this.addChild(new DynamicBorder(border));
		this.addChild(new Spacer(1));
		this.addChild(new Text(title, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(helpText, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(border));
		this.done = done;
	}

	private readonly done: (value: string | undefined) => void;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") this.done(this.input.getValue());
		else if (keybindings.matches(data, "tui.select.cancel")) this.done(undefined);
		else this.input.handleInput(data);
	}
}
