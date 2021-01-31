@extends('layouts.index')

@section('scripts')
    <script>
        let selected = null;

        function showFolderSettings(e) {
            const menu = document.getElementById("folder_context_menu");
            menu.style.display = "block";
            menu.style.top = mouse.y - 40 + "px";
            menu.style.left = mouse.x - 100 + "px";

            selected = e.getAttribute("data-path");
        }

        function hideFolderSettings() {
            document.getElementById("folder_context_menu").style.display = "none";
        }

        // **************************************
        function deleteFileConfirmation() {
            new Window("Delete a file", [
                {
                    value: "Yes",
                    onclick: (win) => {
                        deleteFile();
                        win.close();
                    }
                },
                {
                    value: "No",
                    onclick: (win) => {
                        win.close();
                    }
                }
            ], function () {
                return "Are you sure you want to delete " + selected + "?";
            });
        }

        async function deleteFile() {

            const response = await fetch(`${Routes.index}/api/delete?path=${selected}`);
            const json = await response.json();

            // Show result
            if (json.code != 200) {
                new Window("Error", null, function () {
                    return json.message;
                });
            } else {
                // Refresh the page
                window.location.reload();
            }
        }

        async function showProperties() {
            const reponse = await fetch('{{url("/api/info?")}}' + "path=" + selected);
            const json = await reponse.json();

            new Window("Properties", null, function () {
                return `Size : ${JSON.stringify(json.data.size)} bytes`;
            });
        }

        // **************************************
        window.addEventListener("click", hideFolderSettings);
    </script>
@endsection

@section('content')
    {{-- Display folders --}}
    @if($files instanceof \App\Http\structs\DirectoryStruct)
        @foreach($files->children as $child)
            <div class="folder"
                 onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $child->path)}}';"
                 oncontextmenu="event.preventDefault(); showFolderSettings(this);" data-path="{{$child->path}}">
                <img src="images/folder.png" alt="{{$child->getRelativePath()}}" title="{{$child->getRelativePath()}}"/>
                <br/>
                <span>{{$child->name}}</span>
            </div>
        @endforeach

        {{-- Display files --}}
        @foreach($files->files as $file)
            <div class="file"
                 onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $file->path)}}';"
                 oncontextmenu="event.preventDefault(); showFolderSettings(this);" data-path="{{$file->path}}">
                @if(File::exists("images/icons/$file->extension.png"))
                    <img src="images/icons/{{$file->extension}}.png" class="file_thumnail"
                         alt="{{$file->getRelativePath()}}" title="{{$file->getRelativePath()}}"/>
                @elseif ($file->isImage())
                    <img src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}" class="image_thumnail"
                         alt="{{$file->getRelativePath()}}" title="{{$file->getRelativePath()}}"/>
                @else
                    <img src="images/icons/file.png" class="file_thumnail"/>
                @endif
                <br/>
                <span>{{$file->name}}</span>
            </div>
        @endforeach
    @endif

    <div id="folder_context_menu">
        <ul>
            <li>Rename</li>
            <li onclick="deleteFileConfirmation()">Delete</li>
            <li onclick="showProperties()">Properties</li>
        </ul>
    </div>

@endsection
