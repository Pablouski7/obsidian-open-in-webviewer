import esbuild from "esbuild";
import process from "process";
import { copyStylesheet, pluginBuildOptions } from "./esbuild.shared.mjs";

const prod = process.argv[2] === "production";

copyStylesheet();
const context = await esbuild.context(pluginBuildOptions({ prod }));

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
