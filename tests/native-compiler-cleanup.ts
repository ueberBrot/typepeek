import { afterEach, afterAll } from "vite-plus/test";

import { closeCompilerSessions } from "#typepeek/inspection/compiler-session";

afterEach(closeCompilerSessions);

afterAll(closeCompilerSessions);
