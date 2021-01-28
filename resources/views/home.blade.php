@extends('layouts.index')

@section('scripts')
    <script>
        function showFolderSettings(e) {
            const menu = document.getElementById("folder_context_menu");
            menu.style.display = "block";
            menu.style.top = mouse.y - 40 + "px";
            menu.style.left = mouse.x - 100 + "px";
        }

        function hideFolderSettings() {
            document.getElementById("folder_context_menu").style.display = "none";
        }
    </script>
@endsection

@section('content')
    {{-- Display folders --}}
    @if($files instanceof \App\Http\Controllers\DirectoryStruct)
        @foreach($files->children as $child)
            <div class="folder"
                 onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $child->path)}}';"
                 oncontextmenu="event.preventDefault(); showFolderSettings(this);">
                <img src="images/folder.png" alt="{{$child->getRelativePath()}}" title="{{$child->getRelativePath()}}"/>
                <br/>
                <span>{{$child->name}}</span>
            </div>
        @endforeach

        {{-- Display files --}}
        @foreach($files->files as $file)
            <div class="file"
                 onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $file->path)}}';"
                 oncontextmenu="event.preventDefault(); showFolderSettings(this);">
                @if(File::exists("images/icons/$file->extension.png"))
                    <img src="images/icons/{{$file->extension}}.png" class="file_thumnail"
                         alt="{{$file->getRelativePath()}}" title="{{$file->getRelativePath()}}"/>
                @elseif ($file->isImage())
                    <img src="{{route("get_image", $file->getNative()->getRealPath())}}" class="image_thumnail"
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
            <li>Delete</li>
            <li>Properties</li>
        </ul>
    </div>

@endsection
