import { useState, useCallback, useMemo, useRef } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import * as Popover from "@radix-ui/react-popover";
import { Icon } from "@/components/primitives/Icon";
import { Checkbox } from "@/components/primitives/Checkbox";
import { mdiClose } from "@mdi/js";
import { dateParts, partsToEpoch } from "@/lib/util/date";
import { MONTHS, parseTypedDate } from "@/lib/util/date";
import { dateFmt, dayMonthFmt, shortDateFmt, monthShort } from "@/lib/util/format";
import { t } from "@/lib/i18n";

interface DatePickerProps {
	mode: "date" | "month";
	value: string;
	onChange: (v: string) => void;
	anyYear?: boolean;
	onAnyYearToggle?: (v: boolean) => void;
	showAnyYear?: boolean;
	showTime?: boolean;
	anyTime?: boolean;
	onAnyTimeToggle?: (v: boolean) => void;
	showAnyTime?: boolean;
	tzLocal?: boolean;
	onTzLocalToggle?: (v: boolean) => void;
	showTzLocal?: boolean;
	onYearSelect?: (year: number) => void;
	/** Treat the value as a wall-clock instant encoded as a UTC epoch (the picked
	 *  numbers survive unshifted by the viewer's timezone). Used by location-time
	 *  date filtering, where Rust re-interprets the wall-clock in each pano's zone. */
	wallClock?: boolean;
}

export type DateFlagProps = Pick<
	DatePickerProps,
	| "anyYear"
	| "onAnyYearToggle"
	| "showAnyYear"
	| "anyTime"
	| "onAnyTimeToggle"
	| "showAnyTime"
	| "tzLocal"
	| "onTzLocalToggle"
	| "showTzLocal"
	| "onYearSelect"
>;

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function parseToDate(value: string, wallClock?: boolean): Date | null {
	if (!value) return null;
	// "MM" (anyYear month)
	const mm = /^(\d{2})$/.exec(value);
	if (mm) return new Date(2000, Number(mm[1]) - 1, 1);
	// "MM-DD"
	const md = /^(\d{2})-(\d{2})$/.exec(value);
	if (md) return new Date(2000, Number(md[1]) - 1, Number(md[2]));
	// "YYYY-MM"
	const ym = /^(\d{4})-(\d{2})$/.exec(value);
	if (ym) return new Date(Number(ym[1]), Number(ym[2]) - 1, 1);
	// unix timestamp
	const n = Number(value);
	if (isNaN(n) || value === "") return null;
	// In wall-clock mode the epoch encodes the picked numbers as UTC; re-home them
	// onto a local Date so every local getter below reads the wall-clock value.
	if (wallClock) {
		const p = dateParts(n, true);
		return new Date(p.y, p.mo, p.d, p.h, p.mi);
	}
	return new Date(n * 1000);
}

function formatDisplay(
	value: string,
	mode: "date" | "month",
	anyYear?: boolean,
	anyTime?: boolean,
	wallClock?: boolean,
): string {
	if (!value) return t("Select...");
	if (anyTime) {
		return /^\d{2}:\d{2}$/.test(value) ? value : t("Select...");
	}
	const d = parseToDate(value, wallClock);
	if (!d) return t("Select...");
	if (anyYear) {
		if (mode === "month") {
			return monthShort(d.getMonth());
		}
		return dayMonthFmt.format(d);
	}
	if (mode === "month") {
		return dateFmt.format(d);
	}
	const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
	const dateStr = shortDateFmt.format(d);
	if (hasTime) {
		const timeStr = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
		return `${dateStr} ${timeStr}`;
	}
	return dateStr;
}

function formatHint(mode: "date" | "month", anyYear?: boolean, anyTime?: boolean): string {
	if (anyTime) return "HH:MM";
	if (mode === "month") return anyYear ? "Jun" : "2019-06";
	return anyYear ? "06-03" : "YYYY-MM-DD";
}

function MonthGrid({
	value,
	onChange,
	anyYear,
	onYearSelect,
}: {
	value: string;
	onChange: (v: string) => void;
	anyYear?: boolean;
	onYearSelect?: (year: number) => void;
}) {
	const parsed = parseToDate(value);
	const [year, setYear] = useState(() => parsed?.getFullYear() ?? new Date().getFullYear());
	const selectedMonth = parsed ? parsed.getMonth() : -1;
	const selectedYear = parsed?.getFullYear();

	const handleClick = (monthIdx: number) => {
		if (anyYear) {
			onChange(pad2(monthIdx + 1));
		} else {
			onChange(`${year}-${pad2(monthIdx + 1)}`);
		}
	};

	const currentYear = new Date().getFullYear();
	const yearStart = 2007;
	const years = Array.from({ length: currentYear - yearStart + 1 }, (_, i) => yearStart + i);

	return (
		<div className="month-grid">
			{!anyYear && (
				<div className="month-grid__nav">
					<button type="button" onClick={() => setYear((y) => y - 1)}>
						&lt;
					</button>
					<span>{year}</span>
					<button type="button" onClick={() => setYear((y) => y + 1)}>
						&gt;
					</button>
				</div>
			)}
			{onYearSelect && !anyYear && (
				<div className="month-grid__years">
					{years.map((y) => (
						<button
							key={y}
							type="button"
							className="month-grid__cell"
							onClick={() => onYearSelect(y)}
						>
							{y}
						</button>
					))}
				</div>
			)}
			<div className="month-grid__months">
				{MONTHS.short.map((name, i) => {
					const isSelected = i === selectedMonth && (anyYear || selectedYear === year);
					return (
						<button
							key={name}
							type="button"
							className={`month-grid__cell${isSelected ? " month-grid__cell--selected" : ""}`}
							onClick={() => handleClick(i)}
						>
							{monthShort(i)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function DatePicker({
	mode,
	value,
	onChange,
	anyYear,
	onAnyYearToggle,
	showAnyYear,
	showTime,
	anyTime,
	onAnyTimeToggle,
	showAnyTime,
	tzLocal,
	onTzLocalToggle,
	showTzLocal,
	onYearSelect,
	wallClock,
}: DatePickerProps) {
	const [open, setOpen] = useState(false);
	// Hand-typed text while the trigger input is being edited; null = displaying.
	const [draft, setDraft] = useState<string | null>(null);
	const initialDraftRef = useRef("");
	const inputRef = useRef<HTMLInputElement>(null);

	const selectedDate = parseToDate(value, wallClock) ?? undefined;
	const [navMonth, setNavMonth] = useState<Date>(() => selectedDate ?? new Date());
	const [pendingDate, setPendingDate] = useState<Date | null>(null);
	const [time, setTime] = useState("00:00");

	// Encode the picked Y/M/D[/H/M] to a Unix-seconds epoch. Wall-clock mode emits
	// the numbers as a UTC epoch; otherwise as the local-time instant.
	const encode = useCallback(
		(y: number, mo: number, da: number, h: number, mi: number) =>
			partsToEpoch({ y, mo, d: da, h, mi }, wallClock ?? false),
		[wallClock],
	);

	const commitValue = useCallback(
		(date: Date, timeStr: string) => {
			if (anyYear) {
				onChange(`${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`);
			} else {
				const [h, m] = timeStr.split(":").map(Number);
				onChange(
					String(encode(date.getFullYear(), date.getMonth(), date.getDate(), h || 0, m || 0)),
				);
			}
		},
		[anyYear, onChange, encode],
	);

	const handleDaySelect = useCallback(
		(date: Date | undefined) => {
			if (!date) return;
			if (showTime && !anyYear) {
				setPendingDate(date);
				commitValue(date, time);
			} else {
				if (anyYear) {
					onChange(`${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`);
				} else {
					onChange(String(encode(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0)));
				}
				setOpen(false);
			}
		},
		[anyYear, onChange, showTime, time, commitValue, encode],
	);

	const handleTimeChange = useCallback(
		(newTime: string) => {
			setTime(newTime);
			const date = pendingDate ?? selectedDate;
			if (date) commitValue(date, newTime);
		},
		[pendingDate, selectedDate, commitValue],
	);

	const handleMonthSelect = useCallback(
		(v: string) => {
			onChange(v);
			setOpen(false);
		},
		[onChange],
	);

	const handleOpenChange = useCallback(
		(isOpen: boolean) => {
			if (isOpen) {
				const existing = parseToDate(value, wallClock);
				if (existing) {
					setTime(`${pad2(existing.getHours())}:${pad2(existing.getMinutes())}`);
				} else {
					setTime("00:00");
				}
				setPendingDate(null);
			}
			setOpen(isOpen);
		},
		[value, wallClock],
	);

	// Commit a hand-typed draft. Unparseable or untouched text is dropped and the display falls back to the current value.
	const commitDraft = useCallback(() => {
		if (draft == null || draft === initialDraftRef.current) return;
		const parsed = parseTypedDate(draft, {
			mode,
			anyYear,
			anyTime,
			withTime: showTime && !anyYear,
			wallClock,
		});
		if (parsed != null) onChange(parsed);
	}, [draft, mode, anyYear, anyTime, showTime, wallClock, onChange]);

	// Typed text that parses to nothing: flagged while you type, so blurring away from it
	// is a visible discard rather than a silent one.
	const draftInvalid = useMemo(() => {
		if (draft == null || draft.trim() === "") return false;
		return (
			parseTypedDate(draft, {
				mode,
				anyYear,
				anyTime,
				withTime: showTime && !anyYear,
				wallClock,
			}) == null
		);
	}, [draft, mode, anyYear, anyTime, showTime, wallClock]);

	// Seed the draft with the exact display text: blur then repaints identical pixels,
	// so clicking a calendar day never flashes the old value in another format.
	// parseTypedDate accepts the display forms ("Jun 3, 2019 14:30", "Jun 2019", ...).
	const startEditing = useCallback(() => {
		if (draft == null) {
			const seed = value ? formatDisplay(value, mode, anyYear, anyTime, wallClock) : "";
			initialDraftRef.current = seed;
			setDraft(seed);
		}
		if (!open) handleOpenChange(true);
	}, [draft, value, mode, anyYear, anyTime, wallClock, open, handleOpenChange]);

	const inputSize = anyTime
		? 6
		: mode === "month"
			? anyYear
				? 5
				: 9
			: anyYear
				? 7
				: showTime
					? 17
					: 12;

	return (
		<Popover.Root open={open} onOpenChange={handleOpenChange}>
			<Popover.Anchor asChild>
				<input
					ref={inputRef}
					type="text"
					className={`date-picker__trigger${draftInvalid ? " is-invalid" : ""}`}
					aria-invalid={draftInvalid || undefined}
					size={inputSize}
					value={draft ?? (value ? formatDisplay(value, mode, anyYear, anyTime, wallClock) : "")}
					placeholder={draft != null ? formatHint(mode, anyYear, anyTime) : t("Select...")}
					onFocus={startEditing}
					onClick={startEditing}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => {
						commitDraft();
						setDraft(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault(); // typing a date must not submit an enclosing form
							commitDraft();
							setDraft(null);
							setOpen(false);
							inputRef.current?.blur();
						} else if (e.key === "Escape") {
							e.stopPropagation();
							setDraft(null);
							setOpen(false);
							inputRef.current?.blur();
						}
					}}
				/>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					className="date-picker__popover"
					sideOffset={4}
					align="start"
					collisionPadding={8}
					onOpenAutoFocus={(e) => e.preventDefault()}
					onInteractOutside={(e) => {
						// Clicking the anchor input is not "outside" â€” it would close and
						// instantly re-open via the input's focus/click handlers.
						if (inputRef.current && e.target instanceof Node && inputRef.current.contains(e.target))
							e.preventDefault();
					}}
				>
					{anyTime ? (
						<div className="date-picker__time-only">
							<label>
								{t("Time of day:")}
								<input
									type="time"
									value={/^\d{2}:\d{2}$/.test(value) ? value : ""}
									onChange={(e) => onChange(e.target.value)}
								/>
							</label>
						</div>
					) : mode === "month" ? (
						<MonthGrid
							value={value}
							onChange={handleMonthSelect}
							anyYear={anyYear}
							onYearSelect={
								onYearSelect
									? (y) => {
											onYearSelect(y);
											setOpen(false);
										}
									: undefined
							}
						/>
					) : (
						<>
							<DayPicker
								mode="single"
								selected={pendingDate ?? selectedDate}
								onSelect={handleDaySelect}
								month={navMonth}
								onMonthChange={setNavMonth}
								captionLayout="dropdown"
								navLayout="around"
								startMonth={new Date(2007, 0)}
								endMonth={new Date(new Date().getFullYear() + 1, 11)}
							/>
							{showTime && !anyYear && (
								<div className="date-picker__time">
									<label>
										{t("Time:")}
										<input
											type="time"
											value={time}
											onChange={(e) => handleTimeChange(e.target.value)}
										/>
									</label>
									<button
										type="button"
										className="date-picker__time-clear"
										title={t("Clear time (whole day)")}
										disabled={!time || time === "00:00"}
										onClick={() => handleTimeChange("")}
									>
										<Icon path={mdiClose} size={14} />
									</button>
								</div>
							)}
						</>
					)}
					{(showAnyYear || showAnyTime || showTzLocal) && (
						<div className="date-picker__toggles">
							{showAnyYear && (
								<label className="date-picker__any-year">
									<Checkbox
										checked={anyYear ?? false}
										onChange={(e) => onAnyYearToggle?.(e.target.checked)}
									/>

									{t("Any year")}
								</label>
							)}
							{showAnyTime && (
								<label className="date-picker__any-year">
									<Checkbox
										checked={anyTime ?? false}
										onChange={(e) => onAnyTimeToggle?.(e.target.checked)}
									/>

									{t("Any date")}
								</label>
							)}
							{showTzLocal && (
								<label className="date-picker__any-year">
									<Checkbox
										checked={tzLocal ?? false}
										onChange={(e) => onTzLocalToggle?.(e.target.checked)}
									/>

									{t("Location timezone")}
								</label>
							)}
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
