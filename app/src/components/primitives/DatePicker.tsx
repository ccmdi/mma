import { useState, useCallback } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import * as Popover from "@radix-ui/react-popover";

interface DatePickerProps {
	mode: "date" | "month";
	value: string;
	onChange: (v: string) => void;
	anyYear?: boolean;
	onAnyYearToggle?: (v: boolean) => void;
	showAnyYear?: boolean;
}

const MONTHS_SHORT = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function parseToDate(value: string): Date | null {
	if (!value) return null;
	// "MM-DD"
	const md = /^(\d{2})-(\d{2})$/.exec(value);
	if (md) return new Date(2000, Number(md[1]) - 1, Number(md[2]));
	// "YYYY-MM"
	const ym = /^(\d{4})-(\d{2})$/.exec(value);
	if (ym) return new Date(Number(ym[1]), Number(ym[2]) - 1, 1);
	// unix timestamp
	const n = Number(value);
	if (!isNaN(n) && value !== "") return new Date(n * 1000);
	return null;
}

function formatDisplay(value: string, mode: "date" | "month", anyYear?: boolean): string {
	if (!value) return "Select...";
	const d = parseToDate(value);
	if (!d) return "Select...";
	if (anyYear) {
		if (mode === "month") {
			return MONTHS_SHORT[d.getMonth()] ?? "Select...";
		}
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
	if (mode === "month") {
		return `${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
	}
	return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function MonthGrid({ value, onChange, anyYear }: {
	value: string;
	onChange: (v: string) => void;
	anyYear?: boolean;
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

	return (
		<div className="month-grid">
			{!anyYear && (
				<div className="month-grid__nav">
					<button type="button" onClick={() => setYear(y => y - 1)}>&lt;</button>
					<span>{year}</span>
					<button type="button" onClick={() => setYear(y => y + 1)}>&gt;</button>
				</div>
			)}
			<div className="month-grid__months">
				{MONTHS_SHORT.map((name, i) => {
					const isSelected = i === selectedMonth && (anyYear || selectedYear === year);
					return (
						<button
							key={name}
							type="button"
							className={`month-grid__cell${isSelected ? " month-grid__cell--selected" : ""}`}
							onClick={() => handleClick(i)}
						>
							{name}
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function DatePicker({
	mode, value, onChange, anyYear, onAnyYearToggle, showAnyYear,
}: DatePickerProps) {
	const [open, setOpen] = useState(false);

	const selectedDate = parseToDate(value) ?? undefined;
	const [navMonth, setNavMonth] = useState<Date>(() => selectedDate ?? new Date());

	const handleDaySelect = useCallback(
		(date: Date | undefined) => {
			if (!date) return;
			if (anyYear) {
				onChange(`${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`);
			} else {
				onChange(String(Math.floor(date.getTime() / 1000)));
			}
			setOpen(false);
		},
		[anyYear, onChange],
	);

	const handleMonthSelect = useCallback(
		(v: string) => {
			onChange(v);
			setOpen(false);
		},
		[onChange],
	);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button type="button" className="date-picker__trigger">
					{formatDisplay(value, mode, anyYear)}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					className="date-picker__popover"
					sideOffset={4}
					align="start"
					collisionPadding={8}
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					{mode === "month" ? (
						<MonthGrid value={value} onChange={handleMonthSelect} anyYear={anyYear} />
					) : (
						<DayPicker
							mode="single"
							selected={selectedDate}
							onSelect={handleDaySelect}
							month={navMonth}
							onMonthChange={setNavMonth}
							captionLayout="dropdown"
							navLayout="around"
							startMonth={new Date(2007, 0)}
							endMonth={new Date(new Date().getFullYear() + 1, 11)}
						/>
					)}
					{showAnyYear && (
						<label className="date-picker__any-year">
							<input
								type="checkbox"
								checked={anyYear ?? false}
								onChange={(e) => onAnyYearToggle?.(e.target.checked)}
							/>
							Any year
						</label>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
