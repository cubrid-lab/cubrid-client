import type { ZonedParam } from "./zoned-param.js";

export type QueryParam = string | number | boolean | bigint | Date | Buffer | ZonedParam | null;

export type QueryParams = readonly QueryParam[];
