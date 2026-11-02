import { StringEnum as PiStringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Keep provider-compatible string enums typed when composed with TypeBox objects.
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>(PiStringEnum(values, options));
}
