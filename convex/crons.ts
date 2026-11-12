import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("expire abandoned backup restores", { hours: 1 }, internal.lifecycle.expireRestores, {});
export default crons;
