import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Form, Input, theme } from "antd";
import type { FormListFieldData } from "antd";
import { GripVertical, Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { reorderList } from "@/lib/reorder";

const CONTROL =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06] disabled:pointer-events-none";

function fieldId(field: FormListFieldData): string {
  return String(field.key);
}

export function BaseUrlListInput() {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <Form.List
      name="baseUrls"
      rules={[
        {
          validator: async (_, urls: string[]) => {
            if (!urls || urls.filter((u) => String(u ?? "").trim()).length === 0) {
              return Promise.reject(new Error(t("sites.baseUrl")));
            }
          },
        },
      ]}
    >
      {(fields, { add, remove }, { errors }) => {
        const ids = fields.map(fieldId);
        const urls = (form.getFieldValue("baseUrls") as string[] | undefined) ?? [];
        const activeIndex = activeId == null ? -1 : ids.indexOf(String(activeId));
        const activeUrl = activeIndex >= 0 ? (urls[activeIndex] ?? "") : "";

        const handleDragEnd = (event: DragEndEvent) => {
          const { active, over } = event;
          setActiveId(null);
          if (!over || active.id === over.id) return;
          const from = ids.indexOf(String(active.id));
          const to = ids.indexOf(String(over.id));
          const current = (form.getFieldValue("baseUrls") as string[] | undefined) ?? [];
          const next = reorderList(current, from, to);
          if (next !== current) form.setFieldValue("baseUrls", next);
        };

        return (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={({ active }) => setActiveId(active.id)}
            onDragCancel={() => setActiveId(null)}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-2">
                {fields.map((field, index) => {
                  const { key, ...item } = field;
                  return (
                    <SortableBaseUrlRow
                      key={key}
                      id={fieldId(field)}
                      item={item}
                      canRemove={fields.length > 1}
                      requiredMessage={t("sites.baseUrl")}
                      addLabel={t("sites.addBaseUrl")}
                      removeLabel={t("sites.removeBaseUrl")}
                      dragLabel={t("sites.baseUrls")}
                      onAdd={() => add("", index + 1)}
                      onRemove={() => remove(field.name)}
                    />
                  );
                })}
                <Form.ErrorList errors={errors} />
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={{ duration: 180, easing: "ease" }}>
              {activeId != null ? (
                <DragPreview url={activeUrl} dragLabel={t("sites.baseUrls")} />
              ) : null}
            </DragOverlay>
          </DndContext>
        );
      }}
    </Form.List>
  );
}

function SortableBaseUrlRow({
  id,
  item,
  canRemove,
  requiredMessage,
  addLabel,
  removeLabel,
  dragLabel,
  onAdd,
  onRemove,
}: {
  id: string;
  item: Omit<FormListFieldData, "key">;
  canRemove: boolean;
  requiredMessage: string;
  addLabel: string;
  removeLabel: string;
  dragLabel: string;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const { token } = theme.useToken();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="base-url-row"
      className="flex h-8 items-center gap-1.5"
    >
      <button
        type="button"
        className={`${CONTROL} cursor-grab touch-none active:cursor-grabbing`}
        style={{ color: token.colorTextQuaternary }}
        aria-label={dragLabel}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} className="block" />
      </button>
      <div className="min-w-0 flex-1">
        <Form.Item
          {...item}
          noStyle
          rules={[
            { required: true, message: requiredMessage },
            {
              validator: async (_, value: string) => {
                const v = String(value ?? "").trim();
                if (!v) return;
                if (/\s/.test(v) || !/^https?:\/\//i.test(v)) {
                  return Promise.reject(new Error(requiredMessage));
                }
              },
            },
          ]}
        >
          <Input placeholder="https://api.example.com" allowClear />
        </Form.Item>
      </div>
      <button
        type="button"
        className={CONTROL}
        style={{ color: token.colorTextSecondary }}
        aria-label={addLabel}
        onClick={onAdd}
      >
        <Plus size={14} className="block" />
      </button>
      <button
        type="button"
        className={CONTROL}
        style={{
          color: token.colorTextSecondary,
          opacity: canRemove ? 1 : 0.35,
        }}
        aria-label={removeLabel}
        disabled={!canRemove}
        onClick={onRemove}
      >
        <Minus size={14} className="block" />
      </button>
    </div>
  );
}

function DragPreview({ url, dragLabel }: { url: string; dragLabel: string }) {
  const { token } = theme.useToken();
  return (
    <div
      className="flex h-8 items-center gap-1.5 rounded-md px-1"
      style={{
        background: token.colorBgElevated,
        boxShadow: token.boxShadowSecondary,
        cursor: "grabbing",
      }}
    >
      <span className={CONTROL} style={{ color: token.colorTextQuaternary }} aria-hidden>
        <GripVertical size={14} className="block" />
      </span>
      <Input value={url} readOnly aria-label={dragLabel} />
    </div>
  );
}
