/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { window, Terminal, commands } from 'vscode';

import { ExtensionLocationDescriptor, MountPointDescriptor, MemoryFileSystem, Wasm, WasmPseudoterminal } from '@vscode/wasm-wasi';

import RAL from './ral';
const paths = RAL().path;
import { CommandHandler } from './types';
import { CommandMountPoint, WebShellContributions } from './webShellContributions';


type CommandLine = {
	command: string; args: string[];
};

export class Webshell {

	private readonly wasm: Wasm;
	private readonly contributions: WebShellContributions;
	private readonly pty: WasmPseudoterminal;
	private readonly terminal : Terminal;
	private readonly prompt;

	private cwd: string;
	private readonly commandHandlers: Map<string, CommandHandler>;
	private readonly userBin: MemoryFileSystem;

	constructor(wasm: Wasm, contributions: WebShellContributions, cwd: string, prompt: string = '$ ') {
		this.wasm = wasm;
		this.contributions = contributions;
		this.prompt = prompt;
		this.pty = this.wasm.createPseudoterminal({ history: true });
		this.terminal = window.createTerminal({ name: 'wesh', pty: this.pty, isTransient: true });
		this.terminal.show();
		this.cwd = cwd;
		this.commandHandlers = new Map<string, CommandHandler>();
		this.userBin = wasm.createInMemoryFileSystem();
		for (const contribution of contributions.getCommandMountPoints()) {
			this.registerCommandContribution(contribution);
		}
		contributions.onChanged((event) => {
			for (const add of event.commands.added) {
				this.registerCommandContribution(add);
			}
			for (const remove of event.commands.removed) {
				this.unregisterCommandContribution(remove);
			}
		});
	}

	private registerCommandContribution(contribution: CommandMountPoint): void {
		const basename = paths.basename(contribution.mountPoint);
		const dirname = paths.dirname(contribution.mountPoint);
		if (dirname === '/usr/bin') {
			this.registerCommandHandler(basename, (command: string, args: string[], cwd: string, pty: WasmPseudoterminal, mountPoints?: MountPointDescriptor[] | undefined) => {
				return new Promise<number>((resolve, reject) => {
					commands.executeCommand<number>(contribution.command, command, args, cwd, pty, mountPoints).then(resolve, reject);
				});
			});
		}
	}

	private unregisterCommandContribution(contribution: CommandMountPoint): void {
		const basename = paths.basename(contribution.mountPoint);
		this.unregisterCommandHandler(basename);
	}

	public registerCommandHandler(command: string, handler: CommandHandler): void {
		this.userBin.createFile(command, { size: 1047646n, reader: () => { throw new Error('No permissions'); }});
		this.commandHandlers.set(command, handler);
	}

	public unregisterCommandHandler(command: string): void {
		this.commandHandlers.delete(command);
	}

	public async runCommandLoop(): Promise<void> {
		while (true) {
			void this.pty.prompt(this.getPrompt());
			const line = await this.pty.readline();
			const { command, args } = this.parseCommand(line);
			switch (command) {
				case 'exit':
					this.terminal.dispose();
					return;
				case 'pwd':
					void this.pty.write(`${this.cwd}\r\n`);
					break;
				case 'cd':
					this.handleCd(args);
					break;
				default:
					const handler = this.commandHandlers.get(command);
					if (handler !== undefined) {
						try {
							await handler(command, args, this.cwd, this.pty, this.getAdditionalFileSystems());
						} catch (error: any) {
							const message = error.message ?? error.toString();
							void this.pty.write(`-wesh: executing ${command} failed: ${message}\r\n`);
						}
					} else {
						void this.pty.write(`-wesh: ${command}: command not found\r\n`);
					}
					break;
			}
		}
	}

	private handleCd(args: string[]): void {
		if (args.length > 1) {
			void this.pty.write(`-wesh: cd: too many arguments\r\n`);
			return;
		}
		const path = RAL().path;
		const target = args[0];
		if (path.isAbsolute(target)) {
			this.cwd = target;
		} else {
			this.cwd = path.join(this.cwd, target);
		}
	}

	private parseCommand(line: string): CommandLine {
		if (line.endsWith('\n')) {
			line = line.slice(0, -1);
		}
		const items = line.split(' ');
		return { command: items[0], args: items.slice(1).map(arg => arg.trim()).filter(arg => arg.length > 0) };
	}

	private getPrompt(): string {
		return `\x1b[01;34m${this.cwd}\x1b[0m ${this.prompt}`;
	}

	private getAdditionalFileSystems(): MapDirDescriptor[] {
		const result: MapDirDescriptor[] = [{ kind: 'inMemoryFileSystem', fileSystem: this.userBin, mountPoint: '/usr/bin' }];
		const contributions: ExtensionLocationDescriptor[] = this.contributions.getDirectoryMountPoints().map(entry => ({ kind: 'extensionLocation', extension: entry.extension, path: entry.path, mountPoint: entry.mountPoint }));
		result.push(...contributions);
		return result;
	}
}