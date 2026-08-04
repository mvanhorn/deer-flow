import type { Message } from "@langchain/langgraph-sdk";
import { expect, rs, test } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { I18nContext } from "@/core/i18n/context";
import { enUS } from "@/core/i18n/locales/en-US";
import { DEFAULT_LOCAL_SETTINGS } from "@/core/settings/local";

const streamMockState = rs.hoisted(() => ({
  isLoading: false,
  messages: [] as Message[],
  onFinish: undefined as
    | ((state: { values: { messages: Message[] } }) => void)
    | undefined,
  stop: rs.fn(async () => undefined),
  submit: rs.fn(async () => undefined),
}));

rs.mock("@langchain/langgraph-sdk/react", () => ({
  useStream: (options: {
    onFinish?: (state: { values: { messages: Message[] } }) => void;
  }) => {
    streamMockState.onFinish = options.onFinish;
    return {
      isLoading: streamMockState.isLoading,
      messages: streamMockState.messages,
      stop: streamMockState.stop,
      submit: streamMockState.submit,
      values: {
        artifacts: [],
        messages: streamMockState.messages,
        title: "",
        todos: [],
      },
    };
  },
}));

test("keeps paged history ahead of the local turn after finish", async () => {
  const { threadHistoryQueryKey, useThreadStream } = await import(
    "@/core/threads/hooks",
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const historicalHuman = {
    id: "historical-request",
    run_id: "run-1",
    type: "human",
    content: "Create the project outline",
  } as Message;
  const historicalAssistant = {
    id: "historical-response",
    run_id: "run-1",
    type: "ai",
    content: "Here is the outline",
  } as Message;
  queryClient.setQueryData(threadHistoryQueryKey("thread-1"), {
    pages: [
      {
        data: [
          { content: historicalHuman, run_id: "run-1", seq: 1 },
          { content: historicalAssistant, run_id: "run-1", seq: 2 },
        ],
        has_more: false,
        next_before_seq: null,
      },
    ],
    pageParams: [null],
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        I18nContext.Provider,
        {
          value: {
            locale: "en-US",
            setLocale: () => undefined,
            t: enUS,
          },
        },
        children,
      ),
    );
  const { rerender, result } = renderHook(
    () =>
      useThreadStream({
        context: DEFAULT_LOCAL_SETTINGS.context,
        threadId: "thread-1",
      }),
    { wrapper },
  );

  expect(result.current.thread.messages).toEqual([
    historicalHuman,
    historicalAssistant,
  ]);

  await act(async () => {
    await result.current.sendMessage("thread-1", {
      files: [],
      text: "Build a presentation",
    });
  });

  const earlyAssistantStep = {
    id: "early-assistant-step",
    type: "ai",
    content: "Reading the presentation skill",
  } as Message;
  const injectedHuman = {
    id: "current-request__user",
    type: "human",
    content: "Build a presentation",
  } as Message;
  streamMockState.messages = [earlyAssistantStep, injectedHuman];
  streamMockState.isLoading = true;
  rerender();

  expect(result.current.thread.messages).toEqual([
    historicalHuman,
    historicalAssistant,
    injectedHuman,
    earlyAssistantStep,
  ]);

  act(() => {
    streamMockState.onFinish?.({
      values: { messages: streamMockState.messages },
    });
    streamMockState.isLoading = false;
    rerender();
  });

  expect(result.current.thread.messages).toEqual([
    historicalHuman,
    historicalAssistant,
    injectedHuman,
    earlyAssistantStep,
  ]);
});
