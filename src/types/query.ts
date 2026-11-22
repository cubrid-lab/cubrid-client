import type { CubridBytes } from "./platform.js";
import type { ZonedParam } from "./zoned-param.js";

export type QueryParam =
  | string
  | number
  | boolean
  | bigint
  | Date
  | CubridBytes
  | ZonedParam
  | null;

export type QueryParams = readonly QueryParam[];
