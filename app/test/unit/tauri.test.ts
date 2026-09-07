import { describe, expect, it } from "vitest";
import { fileNameFromPath } from "@/lib/util/fileName";

describe("fileNameFromPath", () => {
  it("returns the final path segment for POSIX paths", () => {
    expect(fileNameFromPath("/tmp/export.json")).toBe("export.json");
  });

  it("returns the final path segment for Windows paths", () => {
    expect(fileNameFromPath("C:\\Users\\me\\Downloads\\custom-name.csv")).toBe(
      "custom-name.csv",
    );
  });
});
