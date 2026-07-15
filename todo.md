
---

need a separate igpu (intel_gpu_top) profiler graph on the right as well.

---

clicking on a graph to expand it shouldn't just bring up a giant version of that one graph--it should fill that full screen modal with the full size historical graphs of all the graphs on the right stacked on top of each other. Right now the graphs are too tall to be useful, and it would increase usefullness to see the historical data in context of the other graphs aligned one on top of another.

---

when I refresh the dashbaord but the server is still live:

- the server should have stored what model was run and what arguments were used, and should send that info to a newly connected client. the client should take that broadcast and select the right model from the dropdown, the right context, the right gpu layers, and fill the llama-server args.

---

yes, the graph already has a matching prefill/thinking/answering section at the top. I want to add color coded sections to indicate throttling and idling. And then what I want to add is a separate graph at the bottom that looks like a gant chart, but has pipeline components on the left for the y axis and time as the x axis, and highlights a bar for the length of time where any single component is the bottleneck, and produces numbers on the right for how much time was spent bottlenecked on any component (and what percent of total time that bottleneck was).
