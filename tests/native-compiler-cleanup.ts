import { afterEach, afterAll } from "vite-plus/test";

import { closeCompilerSessions } from "#typepeek/inspection/compiler/compiler-session";

afterEach(closeCompilerSessions);

afterAll(closeCompilerSessions);
