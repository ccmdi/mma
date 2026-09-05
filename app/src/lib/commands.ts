import { commands } from "@/bindings.gen";

export type Cmd = typeof commands;

/** Every Rust command, typed. Any of them can change in a release. @unstable */
export const cmd: Cmd = commands;
